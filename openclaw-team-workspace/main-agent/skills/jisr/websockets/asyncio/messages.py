from __future__ import annotations

import asyncio
import codecs
import collections
from collections.abc import AsyncIterator, Iterable
from typing import Any, Callable, Generic, Literal, TypeVar, overload

from ..exceptions import ConcurrencyError
from ..frames import OP_BINARY, OP_CONT, OP_TEXT, Frame
from ..typing import Data


__all__ = ["Assembler"]

UTF8Decoder = codecs.getincrementaldecoder("utf-8")

T = TypeVar("T")


class SimpleQueue(Generic[T]):
    """
    Simplified version of :class:`asyncio.Queue`.

    Provides only the subset of functionality needed by :class:`Assembler`.

    """

    def __init__(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.get_waiter: asyncio.Future[None] | None = None
        self.queue: collections.deque[T] = collections.deque()

    def __len__(self) -> int:
        return len(self.queue)

    def put(self, item: T) -> None:
        """Put an item into the queue."""
        self.queue.append(item)
        if self.get_waiter is not None and not self.get_waiter.done():
            self.get_waiter.set_result(None)

    async def get(self, block: bool = True) -> T:
        """Remove and return an item from the queue, waiting if necessary."""
        if not self.queue:
            if not block:
                raise EOFError("stream of frames ended")
            assert self.get_waiter is None, "cannot call get() concurrently"
            self.get_waiter = self.loop.create_future()
            try:
                await self.get_waiter
            finally:
                self.get_waiter.cancel()
                self.get_waiter = None
        return self.queue.popleft()

    def reset(self, items: Iterable[T]) -> None:
        """Put back items into an empty, idle queue."""
        assert self.get_waiter is None, "cannot reset() while get() is running"
        assert not self.queue, "cannot reset() while queue isn't empty"
        self.queue.extend(items)

    def abort(self) -> None:
        """Close the queue, raising EOFError in get() if necessary."""
        if self.get_waiter is not None and not self.get_waiter.done():
            self.get_waiter.set_exception(EOFError("stream of frames ended"))


class Assembler:
    """
    Assemble messages from frames.

    :class:`Assembler` expects only data frames. The stream of frames must
    respect the protocol; if it doesn't, the behavior is undefined.

    Args:
        pause: Called when the buffer of frames goes above the high water mark;
            should pause reading from the network.
        resume: Called when the buffer of frames goes below the low water mark;
            should resume reading from the network.

    """

    def __init__(
        self,
        high: int | None = None,
        low: int | None = None,
        pause: Callable[[], Any] = lambda: None,
        resume: Callable[[], Any] = lambda: None,
    ) -> None:
        # Queue of incoming frames.
        self.frames: SimpleQueue[Frame] = SimpleQueue()

        # We cannot put a hard limit on the size of the queue because a single
        # call to Protocol.data_received() could produce thousands of frames,
        # which must be buffered. Instead, we pause reading when the buffer goes
        # above the high limit and we resume when it goes under the low limit.
        if high is not None and low is None:
            low = high // 4
        if high is None and low is not None:
            high = low * 4
        if high is not None and low is not None:
            if low < 0:
                raise ValueError("low must be positive or equal to zero")
            if high < low:
                raise ValueError("high must be greater than or equal to low")
        self.high, self.low = high, low
        self.pause = pause
        self.resume = resume
        self.paused = False

        # This flag prevents concurrent calls to get() by user code.
        self.get_in_progress = False

        # This flag marks the end of the connection.
        self.closed = False

    @overload
    async def get(self, decode: Literal[True]) -> str: ...

    @overload
    async def get(self, decode: Literal[False]) -> bytes: ...

    @overload
    async def get(self, decode: bool | None = None) -> Data: ...

    async def get(self, decode: bool | None = None) -> Data:
        """
        Read the next message.

        :meth:`get` returns a single :class:`str` or :class:`bytes`.

        If the message is fragmented, :meth:`get` waits until the last frame is
        received, then it reassembles the message and returns it. To receive
        messages frame by frame, use :meth:`get_iter` instead.

        Args:
            decode: :obj:`False` disables UTF-8 decoding of text frames and
                returns :class:`bytes`. :obj:`True` forces UTF-8 decoding of
                binary frames and returns :class:`str`.

        Raises:
            EOFError: If the stream of frames has ended.
            UnicodeDecodeError: If a text frame contains invalid UTF-8.
            ConcurrencyError: If two coroutines run :meth:`get` or
                :meth:`get_iter` concurrently.

        """
        if self.get_in_progress:
            raise ConcurrencyError("get() or get_iter() is already running")
        self.get_in_progress = True

        # Locking with get_in_progress prevents concurrent execution
        # until get() fetches a complete message or is canceled.

        try:
            # Fetch the first frame.
            frame = await self.frames.get(not self.closed)
            self.maybe_resume()
            assert frame.opcode is OP_TEXT or frame.opcode is OP_BINARY
            if decode is None:
                decode = frame.opcode is OP_TEXT
            frames = [frame]

            # Fetch subsequent frames for fragmented messages.
            while not frame.fin:
                try:
                    frame = await self.frames.get(not self.closed)
                except asyncio.CancelledError:
                    # Put frames already received back into the queue
                    # so that future calls to get() can return them.
                    self.frames.reset(frames)
                    raise
                self.maybe_resume()
                assert frame.opcode is OP_CONT
                frames.append(frame)

        finally:
            self.get_in_progress = False

        # This converts frame.data to bytes when it's a bytearray.
        data = b"".join(frame.data for frame in frames)
        if decode:
            return data.decode()
        else:
            return data

    @overload
    def get_iter(self, decode: Literal[True]) -> AsyncIterator[str]: ...

    @overload
    def get_iter(self, decode: Literal[False]) -> AsyncIterator[bytes]: ...

    @overload
    def get_iter(self, decode: bool | None = None) -> AsyncIterator[Data]: ...

    async def get_iter(self, decode: bool | None = None) -> AsyncIterator[Data]:
        """
        Stream the next message.

        Iterating the return value of :meth:`get_iter` asynchronously yields a
        :class:`str` or :class:`bytes` for each frame in the message.

        The iterator must be fully consumed before calling :meth:`get_iter` or
        :meth:`get` again. Else, :exc:`ConcurrencyError` is raised.

        This method only makes sense for fragmented messages. If messages aren't
        fragmented, use :meth:`get` instead.

        Args:
            decode: :obj:`False` disables UTF-8 decoding of text frames and
                returns :class:`bytes`. :obj:`True` forces UTF-8 decoding of
                binary frames and returns :class:`str`.

        Raises:
            EOFError: If the stream of frames has ended.
            UnicodeDecodeError: If a text frame contains invalid UTF-8.
            ConcurrencyError: If two coroutines run :meth:`get` or
                :meth:`get_iter` concurrently.

        """
        if self.get_in_progress:
            raise ConcurrencyError("get() or get_iter() is already running")
        self.get_in_progress = True

        # Locking with get_in_progress prevents concurrent execution
        # until get_iter() fetches a complete message or is canceled.

        # If get_iter() raises an exception e.g. in decoder.decode(),
        # get_in_progress remains set and the connection becomes unusable.

        # Yield the first frame.
        try:
            frame = await self.frames.get(not self.closed)
        except asyncio.CancelledError:
            self.get_in_progress = False
            raise
        self.maybe_resume()
        assert frame.opcode is OP_TEXT or frame.opcode is OP_BINARY
        if decode is None:
            decode = frame.opcode is OP_TEXT
        if decode:
            decoder = UTF8Decoder()
            yield decoder.decode(frame.data, frame.fin)
        else:
            # Convert to bytes when frame.data is a bytearray.
            yield bytes(frame.data)

        # Yield subsequent frames for fragmented messages.
        while not frame.fin:
            # We cannot handle asyncio.CancelledError because we don't buffer
            # previous fragments — we're streaming them. Canceling get_iter()
            # here will leave the assembler in a stuck state. Future calls to
            # get() or get_iter() will raise ConcurrencyError.
            frame = await self.frames.get(not self.closed)
            self.maybe_resume()
            assert frame.opcode is OP_CONT
            if decode:
                yield decoder.decode(frame.data, frame.fin)
            else:
                # Convert to bytes when frame.data is a bytearray.
                yield bytes(frame.data)

        self.get_in_progress = False

    def put(self, frame: Frame) -> None:
        """
        Add ``frame`` to the next message.

        Raises:
            EOFError: If the stream of frames has ended.

        """
        if self.closed:
            raise EOFError("stream of frames ended")

        self.frames.put(frame)
        self.maybe_pause()

    def maybe_pause(self) -> None:
        """Pause the writer if queue is above the high water mark."""
        # Skip if flow control is disabled.
        if self.high is None:
            return

        # Check for "> high" to support high = 0.
        if len(self.frames) > self.high and not self.paused:
            self.paused = True
            self.pause()

    def maybe_resume(self) -> None:
        """Resume the writer if queue is below the low water mark."""
        # Skip if flow control is disabled.
        if self.low is None:
            return

        # Check for "<= low" to support low = 0.
        if len(self.frames) <= self.low and self.paused:
            self.paused = False
            self.resume()

    def close(self) -> None:
        """
        End the stream of frames.

        Calling :meth:`close` concurrently with :meth:`get`, :meth:`get_iter`,
        or :meth:`put` is safe. They will raise :exc:`EOFError`.

        """
        if self.closed:
            return

        self.closed = True

        # Unblock get() or get_iter().
        self.frames.abort()
