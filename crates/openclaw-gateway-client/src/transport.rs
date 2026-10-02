use crate::ClientError;
use futures_util::{Sink, Stream};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio_tungstenite::tungstenite::{Error as TungsteniteError, Message};

/// A connected WebSocket. Flush completes only after the transport accepts the write;
/// dropping it must close the connection and release pending reads and writes.
pub trait GatewayWebSocket:
    Sink<Message, Error = TungsteniteError>
    + Stream<Item = Result<Message, TungsteniteError>>
    + Unpin
    + Send
{
}
impl<T> GatewayWebSocket for T where
    T: Sink<Message, Error = TungsteniteError>
        + Stream<Item = Result<Message, TungsteniteError>>
        + Unpin
        + Send
{
}

/// An injected transport retains the product's networking and trust ownership.
/// It must not reuse a connection across calls or dispatch credentials before TLS approval.
pub trait GatewayWebSocketConnector: std::fmt::Debug + Send + Sync {
    fn connect(
        &self,
        request: tokio_tungstenite::tungstenite::http::Request<()>,
        max_message_bytes: usize,
    ) -> futures_util::future::BoxFuture<'static, Result<Box<dyn GatewayWebSocket>, ClientError>>;
}

pub(crate) struct BoundedWebSocket {
    pub inner: Box<dyn GatewayWebSocket>,
    pub maximum: usize,
}
impl BoundedWebSocket {
    fn check(&self, message: &Message) -> Result<(), TungsteniteError> {
        if message.len() > self.maximum {
            return Err(TungsteniteError::Capacity(
                tokio_tungstenite::tungstenite::error::CapacityError::MessageTooLong {
                    size: message.len(),
                    max_size: self.maximum,
                },
            ));
        }
        Ok(())
    }
}
impl Stream for BoundedWebSocket {
    type Item = Result<Message, TungsteniteError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(self.inner.as_mut()).poll_next(cx) {
            Poll::Ready(Some(Ok(message))) => {
                Poll::Ready(Some(self.check(&message).map(|()| message)))
            }
            other => other,
        }
    }
}
impl Sink<Message> for BoundedWebSocket {
    type Error = TungsteniteError;
    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(self.inner.as_mut()).poll_ready(cx)
    }
    fn start_send(mut self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        self.check(&message)?;
        Pin::new(self.inner.as_mut()).start_send(message)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(self.inner.as_mut()).poll_flush(cx)
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(self.inner.as_mut()).poll_close(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};

    #[tokio::test]
    async fn owner_limits_apply_to_injected_inbound_and_outbound_messages() {
        let (client, server) = tokio::io::duplex(1024);
        let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        let mut peer = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let mut bounded = BoundedWebSocket {
            inner: Box::new(client),
            maximum: 8,
        };
        assert!(matches!(
            bounded.send(Message::Text("oversized".into())).await,
            Err(TungsteniteError::Capacity(_))
        ));
        assert!(futures_util::poll!(peer.next()).is_pending());
        peer.send(Message::Binary(vec![0; 9].into())).await.unwrap();
        assert!(matches!(
            bounded.next().await,
            Some(Err(TungsteniteError::Capacity(_)))
        ));
    }
}
