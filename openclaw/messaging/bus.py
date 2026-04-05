"""Core agent message bus implementation.

Provides a simple publish/subscribe mechanism with dead-letter queue support
for failed message handlers.
"""

from collections import defaultdict, deque
from typing import Any, Callable, Dict, List, Tuple, Optional


class MessageBus:
    """A message bus for intra-component communication.

    Supports topic-based publish/subscribe with error isolation and
    dead-letter queuing for messages that fail processing.
    """

    def __init__(self, max_dlq_size: Optional[int] = None):
        """Initialize a new MessageBus.

        Args:
            max_dlq_size: Maximum number of messages to retain in the dead-letter
                          queue per topic. If None, unlimited.
        """
        # Subscriptions: topic -> list of handler functions
        self._subscriptions: Dict[str, List[Callable[[Any], None]]] = defaultdict(list)
        # Dead-letter queues: topic -> deque of (message, exception, handler)
        self._dlq: Dict[str, deque] = defaultdict(
            lambda: deque(maxlen=max_dlq_size) if max_dlq_size is not None else deque()
        )
        self._max_dlq_size = max_dlq_size

    def subscribe(self, topic: str, handler: Callable[[Any], None]) -> Callable[[], None]:
        """Subscribe a handler to a topic.

        Args:
            topic: The topic to subscribe to.
            handler: A callable that takes a single argument (the message).

        Returns:
            An unsubscribe function that removes this handler.
        """
        self._subscriptions[topic].append(handler)

        def unsubscribe():
            try:
                self._subscriptions[topic].remove(handler)
                # Clean up empty topic lists
                if not self._subscriptions[topic]:
                    del self._subscriptions[topic]
            except (ValueError, KeyError):
                pass  # Handler already removed

        return unsubscribe

    def publish(self, topic: str, message: Any) -> None:
        """Publish a message to all subscribers of a topic.

        If any handler raises an exception, the message is routed to the
        dead-letter queue for that topic along with the error, and processing
        continues with the next handler.

        Args:
            topic: The topic to publish to.
            message: The message payload to deliver.
        """
        handlers = self._subscriptions.get(topic, []).copy()  # Copy to allow mutation during iteration

        for handler in handlers:
            try:
                handler(message)
            except Exception as e:
                # Record in dead-letter queue
                self._dlq[topic].append((message, e, handler))

    def get_dead_letter_queue(self, topic: Optional[str] = None) -> List[Tuple[Any, Exception, Callable[[Any], None]]]:
        """Retrieve dead-letter messages.

        Args:
            topic: If provided, return DLQ for that topic only. If None, return
                   all messages from all topics as a flat list.

        Returns:
            List of tuples (message, exception, handler) in FIFO order.
        """
        if topic is not None:
            return list(self._dlq.get(topic, []))
        else:
            all_messages = []
            for t in sorted(self._dlq.keys()):
                all_messages.extend(self._dlq[t])
            return all_messages

    def clear_dead_letter_queue(self, topic: Optional[str] = None) -> None:
        """Clear the dead-letter queue.

        Args:
            topic: If provided, clear DLQ for that topic only. If None, clear all.
        """
        if topic is not None:
            if topic in self._dlq:
                self._dlq[topic].clear()
        else:
            for t in list(self._dlq.keys()):
                self._dlq[t].clear()
