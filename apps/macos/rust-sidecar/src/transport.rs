//! One acknowledged message each way; IPC demultiplexing never waits for Gateway consumption.
use bytes::Bytes;
use futures_util::{Sink, Stream};
use openclaw_gateway_client::{
    ClientError, GatewayWebSocket, GatewayWebSocketConnector, WebSocketError, WebSocketMessage,
    WebSocketRequest,
};
use openclaw_node_host::SidecarFrameError;
use serde_json::{json, Value};
use std::{
    future::Future,
    ops::Range,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::sync::{mpsc, oneshot};

type Acknowledgement = Arc<Mutex<Option<(u64, oneshot::Sender<bool>)>>>;

// Private transport records are negotiated before either peer can open a Gateway.
// Their domain is distinct from OCSC, whose payload remains strictly UTF-8 JSON.
pub const TRANSPORT_DOMAIN: [u8; 4] = *b"OCMT";
// Payload: kind (1 text, 2 binary, 3 ping, 4 close), big-endian u64 id, raw body.
// Native inbound ids are zero; runtime outbound ids correlate unchanged JSON receipts.
pub struct TransportWrite(u64, u8, WebSocketMessage);

impl TransportWrite {
    pub fn payload_parts(&self) -> ([u8; 9], &[u8]) {
        let mut metadata = [0; 9];
        metadata[0] = self.1;
        metadata[1..].copy_from_slice(&self.0.to_be_bytes());
        let body = match &self.2 {
            WebSocketMessage::Text(text) => text.as_bytes(),
            WebSocketMessage::Binary(bytes) => bytes.as_ref(),
            // URLSession owns ping and close wire payloads, as in the JSON relay.
            _ => &[],
        };
        (metadata, body)
    }
}

pub fn decode_record(
    payload: &[u8],
    range: Range<usize>,
) -> Result<(u8, Range<usize>), SidecarFrameError> {
    let invalid = || SidecarFrameError::InvalidOpaquePayload;
    let metadata = payload.get(..9).ok_or_else(invalid)?;
    let kind = metadata[0];
    if metadata[1..] != [0; 8]
        || !matches!(kind, 1 | 2)
        || payload.len() - 9 > super::GATEWAY_PAYLOAD_LIMIT
        || (kind == 1 && std::str::from_utf8(&payload[9..]).is_err())
    {
        return Err(invalid());
    }
    Ok((kind, range.start + 9..range.end))
}

pub struct NativeTransport {
    incoming: mpsc::Receiver<WebSocketMessage>,
    outgoing: mpsc::Sender<TransportWrite>,
    receipts: mpsc::Sender<Value>,
    acknowledgement: Acknowledgement,
    pending: Option<oneshot::Receiver<bool>>,
    pong: Option<(WebSocketMessage, oneshot::Receiver<bool>)>,
    pong_acknowledgement: Acknowledgement,
    sequence: u64,
}

pub struct NativeTransportInput {
    incoming: mpsc::Sender<WebSocketMessage>,
    acknowledgement: Acknowledgement,
    pong_acknowledgement: Acknowledgement,
}

impl NativeTransport {
    pub fn new(
        outgoing: mpsc::Sender<TransportWrite>,
        receipts: mpsc::Sender<Value>,
    ) -> (Self, NativeTransportInput) {
        let (incoming_tx, incoming) = mpsc::channel(1);
        let acknowledgement = Arc::new(Mutex::new(None));
        let pong_acknowledgement = Arc::new(Mutex::new(None));
        (
            Self {
                incoming,
                outgoing,
                receipts,
                acknowledgement: acknowledgement.clone(),
                pending: None,
                pong: None,
                pong_acknowledgement: pong_acknowledgement.clone(),
                sequence: 0,
            },
            NativeTransportInput {
                incoming: incoming_tx,
                acknowledgement,
                pong_acknowledgement,
            },
        )
    }
}

impl NativeTransportInput {
    pub fn receive(&self, kind: u8, data: Bytes) -> Result<(), &'static str> {
        if data.len() > super::GATEWAY_PAYLOAD_LIMIT {
            return Err("transport frame too large");
        }
        let message = match kind {
            1 => WebSocketMessage::Text(data.try_into().map_err(|_| "invalid text frame")?),
            2 => WebSocketMessage::Binary(data),
            _ => return Err("invalid transport message kind"),
        };
        self.incoming
            .try_send(message)
            .map_err(|_| "unacknowledged transport frame")
    }

    pub fn acknowledge(&self, id: u64, ok: bool) -> Result<(), &'static str> {
        acknowledge(&self.acknowledgement, id, ok)
    }

    pub fn pong(&self, id: u64, ok: bool) -> Result<(), &'static str> {
        acknowledge(&self.pong_acknowledgement, id, ok)
    }
}

impl Drop for NativeTransportInput {
    fn drop(&mut self) {
        self.acknowledgement.lock().unwrap().take();
        self.pong_acknowledgement.lock().unwrap().take();
    }
}

fn acknowledge(slot: &Acknowledgement, id: u64, ok: bool) -> Result<(), &'static str> {
    let (expected, reply) = slot
        .lock()
        .unwrap()
        .take()
        .ok_or("unexpected transport receipt")?;
    if expected != id {
        return Err("transport receipt mismatch");
    }
    reply.send(ok).map_err(|_| "transport closed")
}

fn closed() -> WebSocketError {
    WebSocketError::ConnectionClosed
}

impl Stream for NativeTransport {
    type Item = Result<WebSocketMessage, WebSocketError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some((_, receipt)) = self.pong.as_mut() {
            match Pin::new(receipt).poll(cx) {
                Poll::Ready(Ok(true)) => {
                    let (pong, _) = self.pong.take().unwrap();
                    return Poll::Ready(Some(Ok(pong)));
                }
                Poll::Ready(_) => {
                    self.pong = None;
                    return Poll::Ready(Some(Err(closed())));
                }
                Poll::Pending => {}
            }
        }
        match self.incoming.poll_recv(cx) {
            Poll::Ready(Some(message)) => {
                // The native peer cannot read its next network message before this receipt.
                if self
                    .receipts
                    .try_send(json!({"type":"transport-received"}))
                    .is_err()
                {
                    return Poll::Ready(Some(Err(closed())));
                }
                Poll::Ready(Some(Ok(message)))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Sink<WebSocketMessage> for NativeTransport {
    type Error = WebSocketError;
    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.poll_flush(cx)
    }
    fn start_send(mut self: Pin<&mut Self>, message: WebSocketMessage) -> Result<(), Self::Error> {
        if self.pending.is_some() {
            return Err(closed());
        }
        let (kind, pong) = match &message {
            message @ (WebSocketMessage::Text(_) | WebSocketMessage::Binary(_)) => {
                let kind = if message.is_text() { 1 } else { 2 };
                if message.len() > super::GATEWAY_PAYLOAD_LIMIT {
                    return Err(closed());
                }
                (kind, None)
            }
            WebSocketMessage::Ping(bytes) => {
                if self.pong.is_some() {
                    return Err(closed());
                }
                (3, Some(WebSocketMessage::Pong(bytes.clone())))
            }
            WebSocketMessage::Close(_) => (4, None),
            // URLSession owns unsolicited WebSocket ping/pong responses.
            WebSocketMessage::Pong(_) => return Ok(()),
            _ => return Err(closed()),
        };
        self.sequence = self.sequence.checked_add(1).ok_or_else(closed)?;
        if let Some(pong) = pong {
            let (reply, receipt) = oneshot::channel();
            *self.pong_acknowledgement.lock().unwrap() = Some((self.sequence, reply));
            self.pong = Some((pong, receipt));
        }
        let (reply, receive) = oneshot::channel();
        *self.acknowledgement.lock().unwrap() = Some((self.sequence, reply));
        self.pending = Some(receive);
        let frame = TransportWrite(self.sequence, kind, message);
        self.outgoing.try_send(frame).map_err(|_| closed())
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let Some(pending) = self.pending.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        match Pin::new(pending).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(true)) => {
                self.pending = None;
                // Flush confirms native submission, never remote Pong. Waiting for Pong here
                // would prevent reading the inbound frame that lets URLSession observe it.
                Poll::Ready(Ok(()))
            }
            Poll::Ready(_) => {
                self.pending = None;
                Poll::Ready(Err(closed()))
            }
        }
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Closing the product session retires both the helper and the URLSession task.
        self.incoming.close();
        self.poll_flush(cx)
    }
}

pub struct NativeConnector(Mutex<Option<NativeTransport>>);
impl NativeConnector {
    pub fn new(transport: NativeTransport) -> Self {
        Self(Mutex::new(Some(transport)))
    }
}
impl std::fmt::Debug for NativeConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeConnector")
    }
}
impl GatewayWebSocketConnector for NativeConnector {
    fn connect(
        &self,
        _: WebSocketRequest<()>,
        _: usize,
    ) -> futures_util::future::BoxFuture<'static, Result<Box<dyn GatewayWebSocket>, ClientError>>
    {
        let socket = self.0.lock().unwrap().take();
        Box::pin(async move {
            socket
                .map(|socket| Box::new(socket) as Box<dyn GatewayWebSocket>)
                .ok_or_else(|| ClientError::Closed("native transport already consumed".into()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};

    #[tokio::test]
    async fn ping_submission_is_not_a_pong_and_does_not_stop_inbound_messages() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, mut acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        let mut send = Box::pin(socket.send(WebSocketMessage::Ping(b"ping-1".to_vec().into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let write = writes.recv().await.unwrap();
        native.acknowledge(write.0, true).unwrap();
        send.await.unwrap();
        // Submission is not evidence of peer liveness. Stream must await the real Pong.
        assert!(futures_util::poll!(socket.next()).is_pending());
        native
            .receive(1, Bytes::from_static(b"tick before pong"))
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "tick before pong"
        );
        acknowledgements.recv().await.unwrap();
        let observed = tokio::spawn(async move { socket.next().await });
        tokio::task::yield_now().await;
        native.pong(write.0, true).unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), observed)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .unwrap(),
            WebSocketMessage::Pong(b"ping-1".to_vec().into())
        );
    }

    #[tokio::test]
    async fn early_pong_survives_submission_and_other_writes_without_overwriting_correlation() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, _acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        let mut send = Box::pin(socket.send(WebSocketMessage::Ping(b"first".to_vec().into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let ping = writes.recv().await.unwrap().0;
        native.pong(ping, true).unwrap();
        native.acknowledge(ping, true).unwrap();
        send.await.unwrap();
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("result".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let text = writes.recv().await.unwrap().0;
        native.acknowledge(text, true).unwrap();
        send.await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            WebSocketMessage::Pong(b"first".to_vec().into())
        );
        assert!(native.pong(ping, true).is_err());
    }

    #[tokio::test]
    async fn only_one_ping_can_wait_and_failed_pong_is_not_liveness() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, _acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        let mut send = Box::pin(socket.send(WebSocketMessage::Ping(b"pending".to_vec().into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let ping = writes.recv().await.unwrap().0;
        native.acknowledge(ping, true).unwrap();
        send.await.unwrap();
        assert!(socket
            .send(WebSocketMessage::Ping(b"duplicate".to_vec().into()))
            .await
            .is_err());
        native.pong(ping, false).unwrap();
        assert!(socket.next().await.unwrap().is_err());
    }

    #[tokio::test]
    async fn duplex_receipts_do_not_wait_for_the_gateway_receive_loop() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, mut acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        native.receive(1, Bytes::from_static(b"challenge")).unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "challenge"
        );
        assert_eq!(
            acknowledgements.recv().await.unwrap()["type"],
            "transport-received"
        );
        // The Gateway can answer immediately, before URLSession reports the write complete.
        // Delivering that response must not consume or obstruct the independent write receipt.
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("connect".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let write = writes.recv().await.unwrap();
        native.receive(1, Bytes::from_static(b"hello")).unwrap();
        native.acknowledge(write.0, true).unwrap();
        send.await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "hello"
        );
    }

    #[tokio::test]
    async fn native_input_is_bounded_and_closure_releases_pending_work() {
        let (outgoing, _writes) = mpsc::channel(1);
        let (receipts, _acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        native.receive(1, Bytes::from_static(b"one")).unwrap();
        assert!(native.receive(1, Bytes::from_static(b"two")).is_err());
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("pending".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        // EOF from the authenticated native reader retires the sole write acknowledgement.
        drop(native);
        assert!(send.await.is_err());
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "one"
        );
        assert!(socket.next().await.is_none());
    }

    #[test]
    fn opaque_wire_matches_independent_hmac_vectors_in_both_directions() {
        use openclaw_node_host::{AuthenticatedSidecarChannel, SidecarPeerRole, SidecarSessionKey};
        for (role, id, expected) in [
            (SidecarPeerRole::Supervisor, 0, "4f434d540001000001000000000000000700000000000000010008000000107632322d7465737402000000000000000000ff225c0ac3a9c385da29ce4c34c5954fba025a92aa2a0da295acc9334573f346ecbf5f95ae23"),
            (SidecarPeerRole::Runtime, 0x0102030405060708, "4f434d540001000002000000000000000700000000000000010008000000107632322d7465737402010203040506070800ff225c0ac3a9339b79277dc32fd8a94f9f8f72aba024cb25dc515cea6f390fbd6fa4cb028f91"),
        ] {
            let mut channel = AuthenticatedSidecarChannel::new(role, "v22-test".into(), 7,
                SidecarSessionKey::from_bytes([0x5a; 32]), 4096).unwrap();
            let write = TransportWrite(id, 2, WebSocketMessage::Binary(vec![0, 255, 34, 92, 10, 195, 169].into()));
            let (metadata, body) = write.payload_parts();
            let (header, tag) = channel.seal_opaque_parts(TRANSPORT_DOMAIN, &[&metadata, body]).unwrap();
            let frame = [header.as_slice(), &metadata, body, &tag].concat();
            let hex: String = frame.iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(hex, expected);
        }
    }

    #[test]
    fn incoming_record_validates_complete_metadata_and_strict_text() {
        for kind in [1, 2] {
            let mut payload = vec![kind, 0, 0, 0, 0, 0, 0, 0, 0];
            payload.extend_from_slice("é🦀".as_bytes());
            assert_eq!(
                decode_record(&payload, 40..40 + payload.len()).unwrap(),
                (kind, 49..40 + payload.len())
            );
        }
        for invalid in [
            vec![],
            vec![2; 8],
            vec![0; 9],
            vec![3, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![4, 0, 0, 0, 0, 0, 0, 0, 0],
            vec![2, 0, 0, 0, 0, 0, 0, 0, 1],
            vec![1, 0, 0, 0, 0, 0, 0, 0, 0, 0xff],
        ] {
            assert!(decode_record(&invalid, 0..invalid.len()).is_err());
        }
        let binary = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0xff];
        assert_eq!(decode_record(&binary, 0..binary.len()).unwrap(), (2, 9..10));
    }

    #[tokio::test]
    async fn authenticated_input_transfers_storage_and_output_borrows_it() {
        use openclaw_node_host::{AuthenticatedSidecarChannel, SidecarPeerRole, SidecarSessionKey};
        let make_channel = |role| {
            AuthenticatedSidecarChannel::new(
                role,
                "transfer".into(),
                7,
                SidecarSessionKey::from_bytes([0x5a; 32]),
                4096,
            )
            .unwrap()
        };
        let mut sender = make_channel(SidecarPeerRole::Supervisor);
        let mut receiver = make_channel(SidecarPeerRole::Runtime);
        let metadata = [2, 0, 0, 0, 0, 0, 0, 0, 0];
        let payload = vec![0xff; 2048];
        let (header, tag) = sender
            .seal_opaque_parts(TRANSPORT_DOMAIN, &[&metadata, &payload])
            .unwrap();
        let mut frame = [header.as_slice(), &metadata, &payload, &tag].concat();
        let (kind, range): (u8, Range<usize>) = receiver
            .open_reusing_with_opaque(
                &mut frame,
                TRANSPORT_DOMAIN,
                |_| unreachable!(),
                decode_record,
            )
            .unwrap();
        let original = frame[range.clone()].as_ptr();
        let bytes = Bytes::from(frame).slice(range);
        assert_eq!(bytes.as_ptr(), original);
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, _acks) = mpsc::channel(1);
        let (mut socket, input) = NativeTransport::new(outgoing, receipts);
        input.receive(kind, bytes).unwrap();
        let message = socket.next().await.unwrap().unwrap();
        assert_eq!(message.len(), payload.len());
        assert_eq!(message.clone().into_data().as_ptr(), original);
        let mut sending = Box::pin(socket.send(message));
        assert!(futures_util::poll!(&mut sending).is_pending());
        let write = writes.recv().await.unwrap();
        let (metadata, body) = write.payload_parts();
        assert_eq!(metadata[0], 2);
        assert_eq!(body.as_ptr(), original);
        input.acknowledge(write.0, true).unwrap();
        sending.await.unwrap();
    }

    #[tokio::test]
    async fn full_gateway_payload_survives_opaque_relay_and_oversize_is_rejected() {
        for binary in [false, true] {
            let (outgoing, mut writes) = mpsc::channel(1);
            let (receipts, mut acknowledgements) = mpsc::channel(1);
            let (mut socket, native) = NativeTransport::new(outgoing, receipts);
            let bytes = vec![if binary { 0xff } else { b'/' }; super::super::GATEWAY_PAYLOAD_LIMIT];
            let message = if binary {
                WebSocketMessage::Binary(bytes.clone().into())
            } else {
                WebSocketMessage::Text(String::from_utf8(bytes.clone()).unwrap().into())
            };
            let mut send = Box::pin(socket.send(message));
            assert!(futures_util::poll!(&mut send).is_pending());
            let write = writes.recv().await.unwrap();
            let (metadata, body) = write.payload_parts();
            assert_eq!(body, bytes);
            assert_eq!(metadata[0], if binary { 2 } else { 1 });
            assert_eq!(
                u64::from_be_bytes(metadata[1..].try_into().unwrap()),
                write.0
            );
            native
                .receive(metadata[0], Bytes::copy_from_slice(body))
                .unwrap();
            native.acknowledge(write.0, true).unwrap();
            send.await.unwrap();
            let received = socket.next().await.unwrap().unwrap();
            assert_eq!(received.is_binary(), binary);
            assert_eq!(received.into_data(), bytes);
            acknowledgements.recv().await.unwrap();
            assert!(native
                .receive(
                    2,
                    Bytes::from(vec![0; super::super::GATEWAY_PAYLOAD_LIMIT + 1])
                )
                .is_err());
            native
                .receive(1, Bytes::from_static(b"still-alive"))
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().into_text().unwrap(),
                "still-alive"
            );
        }
    }
}
