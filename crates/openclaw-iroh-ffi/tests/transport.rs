use openclaw_iroh_ffi::{BiStream, CloseKind, Connection, Endpoint, IrohError, bind};
use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::time::timeout;

const ALPN: &[u8] = b"openclaw/tunnel/1";
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(5), future)
        .await
        .expect("operation hung")
}
async fn endpoint(seed: u8) -> Arc<Endpoint> {
    bind(vec![seed; 32], None, vec![ALPN.to_vec()], true, 1000)
        .await
        .unwrap()
}
fn loopback(endpoint: &Endpoint) -> Vec<String> {
    endpoint
        .bound_sockets()
        .iter()
        .map(|s| {
            let mut addr: SocketAddr = s.parse().unwrap();
            addr.set_ip(match addr.ip() {
                IpAddr::V4(_) => Ipv4Addr::LOCALHOST.into(),
                IpAddr::V6(_) => Ipv6Addr::LOCALHOST.into(),
            });
            addr.to_string()
        })
        .collect()
}
async fn pair() -> (
    Arc<Endpoint>,
    Arc<Endpoint>,
    Arc<Connection>,
    Arc<Connection>,
) {
    let server = endpoint(1).await;
    let client = endpoint(2).await;
    let (outgoing, incoming) = bounded(async {
        tokio::join!(
            client.connect(server.id(), ALPN.to_vec(), None, loopback(&server)),
            server.accept()
        )
    })
    .await;
    (
        server,
        client,
        outgoing.unwrap(),
        incoming.unwrap().unwrap(),
    )
}
async fn streams(client: &Connection, server: &Connection) -> (BiStream, BiStream) {
    let local = client.open_bi().await.unwrap();
    local.send.write(b"x".to_vec()).await.unwrap();
    let peer = bounded(server.accept_bi()).await.unwrap();
    assert_eq!(peer.recv.read(1).await.unwrap(), Some(b"x".to_vec()));
    (local, peer)
}

#[tokio::test]
async fn direct_alpn_streams_and_full_range_close_codes() {
    let (server, client, conn, accepted) = pair().await;
    assert_eq!(conn.remote_id(), server.id());
    assert_eq!(accepted.remote_id(), client.id());
    accepted.set_max_concurrent_bi_streams(64);
    let (local, peer) = streams(&conn, &accepted).await;
    // Reject invalid signed codes before any connection or stream state changes.
    for code in [-1, 1_i64 << 62] {
        assert!(matches!(
            conn.close(code, vec![]),
            Err(IrohError::InvalidArgument { .. })
        ));
        assert!(matches!(
            local.send.reset(code).await,
            Err(IrohError::InvalidArgument { .. })
        ));
        assert!(matches!(
            local.recv.stop(code).await,
            Err(IrohError::InvalidArgument { .. })
        ));
    }
    peer.send.write(b"still readable".to_vec()).await.unwrap();
    assert_eq!(
        bounded(local.recv.read(64)).await.unwrap(),
        Some(b"still readable".to_vec())
    );
    local.send.write(b"tunnel".to_vec()).await.unwrap();
    local.send.finish().await.unwrap();
    assert_eq!(
        bounded(peer.recv.read(64)).await.unwrap(),
        Some(b"tunnel".to_vec())
    );
    assert_eq!(bounded(peer.recv.read(64)).await.unwrap(), None);
    let high = (1_i64 << 62) - 1;
    accepted.close(high, b"display only".to_vec()).unwrap();
    let close = bounded(conn.closed()).await;
    assert_eq!(close.kind, CloseKind::Application);
    assert_eq!(close.code, Some(high));
    assert_eq!(close.reason, "display only");
    bounded(client.shutdown()).await;
    bounded(server.shutdown()).await;
}

#[tokio::test]
async fn stop_reset_and_shutdown_interrupt_blocked_operations() {
    let (server, client, conn, accepted) = pair().await;
    let (local, peer) = streams(&conn, &accepted).await;
    // Explicitly poll pending I/O once before invoking its interrupt (no timing sleeps).
    let mut read = Box::pin(local.recv.read(64));
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(read.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    let high = (1_i64 << 62) - 1;
    let (stopped, read) = bounded(async { tokio::join!(local.recv.stop(high), read) }).await;
    stopped.unwrap();
    assert!(matches!(read, Err(IrohError::Cancelled)));
    let stopped = bounded(peer.send.write(vec![0; 64 << 20])).await;
    assert!(matches!(stopped, Err(IrohError::StreamStopped { code }) if code == high));

    let mut write = Box::pin(local.send.write(vec![0; 64 << 20]));
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(write.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    let (reset, write) = bounded(async { tokio::join!(local.send.reset(high), write) }).await;
    reset.unwrap();
    assert!(matches!(write, Err(IrohError::Cancelled)));
    let reset = bounded(async {
        loop {
            match peer.recv.read(1 << 20).await {
                Ok(Some(_)) => {}
                other => break other,
            }
        }
    })
    .await;
    assert!(matches!(reset, Err(IrohError::StreamReset { code }) if code == high));

    let (local, _peer) = streams(&conn, &accepted).await;
    let watcher = client.watch_home_relay().await;
    assert!(watcher.next().await.unwrap().is_empty());
    let mut read = Box::pin(local.recv.read(64));
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(read.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    let mut accept = Box::pin(client.accept());
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(accept.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    // An unused loopback UDP address guarantees a handshake that cannot complete.
    let unused = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let mut connect = Box::pin(client.connect(
        endpoint(3).await.id(),
        ALPN.to_vec(),
        None,
        vec![unused.local_addr().unwrap().to_string()],
    ));
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(connect.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    bounded(client.shutdown()).await;
    assert!(matches!(
        bounded(read).await,
        Err(IrohError::EndpointClosed)
    ));
    assert!(bounded(accept).await.unwrap().is_none());
    assert!(matches!(
        bounded(connect).await,
        Err(IrohError::EndpointClosed)
    ));
    assert!(bounded(watcher.next()).await.is_none());
    assert!(bounded(watcher.next()).await.is_none());
    bounded(server.shutdown()).await;
}

#[tokio::test]
async fn rejects_invalid_bind_inputs_and_read_bounds() {
    assert!(matches!(
        bind(vec![42; 32], None, vec![], true, 0).await,
        Err(IrohError::InvalidArgument { .. })
    ));
    assert!(bind(vec![42; 31], None, vec![], true, 1000).await.is_err());
    assert!(
        bind(vec![42; 32], Some("not a url".into()), vec![], true, 1000)
            .await
            .is_err()
    );
    let (server, client, conn, accepted) = pair().await;
    let (local, _peer) = streams(&conn, &accepted).await;
    assert!(local.recv.read(0).await.is_err());
    assert!(local.recv.read((1 << 20) + 1).await.is_err());
    bounded(client.shutdown()).await;
    bounded(server.shutdown()).await;
}
