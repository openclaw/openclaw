from __future__ import annotations

import codecs
import queue
import threading
from typing import Any, Callable, Iterable, Iterator, Literal, overload

from ..exceptions import ConcurrencyError
from ..frames import OP_BINARY, OP_CONT, OP_TEXT, Frame
from ..typing import Data
from .utils import Deadline


__all__ = ["Assembler"]

UTF8Decoder = codecs.getincrementaldecoder("utf-8")


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
        # Serialize reads and writes -- except for reads via synchronization
        # primitives provided by the threading and queue modules.
        self.mutex = threading.Lock()

        # Queue of incoming frames.
        self.frames: queue.SimpleQueue[Frame | None] = queue.SimpleQueue()

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

    def get_next_frame(self, timeout: float | None = None) -> Frame:
        # Helper to factor out the logic for getting the next frame from the
        # queue, while handling timeouts and reaching the end of the stream.
        if self.closed:
            try:
                frame = self.frames.get(block=False)
            except queue.Empty:
                raise EOFError("stream of frames ended") from None
        else:
            try:
                # Check for a frame that's already received if timeout <= 0.
                # SimpleQueue.get() doesn't support negative timeout values.
                if timeout is not None and timeout <= 0:
                    frame = self.frames.get(block=False)
                else:
                    frame = self.frames.get(block=True, timeout=timeout)
            except queue.Empty:
                raise TimeoutError(f"timed out in {timeout:.1f}s") from None
        if frame is None:
            raise EOFError("stream of frames ended")
        return frame

    def reset_queue(self, frames: Iterable[Frame]) -> None:
        # Helper to put frames back into the queue after they were fetched.
        # This happens only when the queue is empty. However, by the time
        # we acquire self.mutex, put() may have added items in the queue.
        # Therefore, we must handle the case where the queue is not empty.
        frame: Frame | None
        with self.mutex:
            queued = []
            try:
                while True:
                    queued.append(self.frames.get(block=False))
            except queue.Empty:
                pass
            for frame in frames:
                self.frames.put(frame)
            # This loop runs only when a race condition occurs.
            for frame in queued:  # pragma: no cover
                self.frames.put(frame)

    # This overload structure is required to avoid the error:
    # "parameter without a default follows parameter with a default"

    @overload
    def get(self, timeout: float | None, decode: Literal[True]) -> str: ...

    @overload
    def get(self, timeout: float | None, decode: Literal[False]) -> bytes: ...

    @overload
    def get(self, timeout: float | None = None, *, decode: Literal[True]) -> str: ...

    @overload
    def get(self, timeout: float | None = None, *, decode: Literal[False]) -> bytes: ...

    @overload
    def get(self, timeout: float | None = None, decode: bool | None = None) -> Data: ...

    def get(self, timeout: float | None = None, decode: bool | None = None) -> Data:
        """
        Read the next message.

        :meth:`get` returns a single :class:`str` or :class:`bytes`.

        If the message is fragmented, :meth:`get` waits until the last frame is
        received, then it reassembles the message and returns it. To receive
        messages frame by frame, use :meth:`get_iter` instead.

        Args:
            timeout: If a timeout is provided and elapses before a complete
                message is received, :meth:`get` raises :exc:`TimeoutError`.
            decode: :obj:`False` disables UTF-8 decoding of text frames and
                returns :class:`bytes`. :obj:`True` forces UTF-8 decoding of
                binary frames and returns :class:`str`.

        Raises:
            EOFError: If the stream of frames has ended.
            UnicodeDecodeError: If a text frame contains invalid UTF-8.
            ConcurrencyError: If two coroutines run :meth:`get` or
                :meth:`get_iter` concurrently.
            TimeoutError: If a timeout is provided and elapses before a
                complete message is received.

        """
        with self.mutex:
            if self.get_in_progress:
                raise ConcurrencyError("get() or get_iter() is already running")
            self.get_in_progress = True

        # Locking with get_in_progress prevents concurrent execution
        # until get() fetches a complete message or times out.

        try:
            deadline = Deadline(timeout)

            # Fetch the first frame.
            frame = self.get_next_frame(deadline.timeout(raise_if_elapsed=False))
            with self.mutex:
                self.maybe_resume()
            assert frame.opcode is OP_TEXT or frame.opcode is OP_BINARY
            if decode is None:
                decode = frame.opcode is OP_TEXT
            frames = [frame]

            # Fetch subsequent frames for fragmented messages.
            while not frame.fin:
                try:
                    frame = self.get_next_frame(
                        deadline.timeout(raise_if_elapsed=False)
                    )
                except TimeoutError:
                    # Put frames already received back into the queue
                    # so that future calls to get() can return them.
                    self.reset_queue(frames)
                    raise
                with self.mutex:
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
    def get_iter(self, decode: Literal[True]) -> Iterator[str]: ...

    @overload
    def get_iter(self, decode: Literal[False]) -> Iterator[bytes]: ...

    @overload
    def get_iter(self, decode: bool | None = None) -> Iterator[Data]: ...

    def get_iter(self, decode: bool | None = None) -> Iterator[Data]:
        """
        Stream the next message.

        Iterating the return value of :meth:`get_iter` yields a :class:`str` or
        :class:`bytes` for each frame in the message.

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
        with self.mutex:
            if self.get_in_progress:
                raise ConcurrencyError("get() or get_iter() is already running")
            self.get_in_progress = True

        # Locking with get_in_progress prevents concurrent execution
        # until get_iter() fetches a complete message or times out.

        # If get_iter() raises an exception e.g. in decoder.decode(),
        # get_in_progress remains set and the connection becomes unusable.

        # Yield the first frame.
        frame = self.get_next_frame()
        with self.mutex:
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
            frame = self.get_next_frame()
            with self.mutex:
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
        with self.mutex:
            if self.closed:
                raise EOFError("stream of frames ended")

            self.frames.put(frame)
            self.maybe_pause()

    # put() and get/get_iter() call maybe_pause() and maybe_resume() while
    # holding self.mutex. This guarantees that the calls interleave properly.
    # Specifically, it prevents a race condition where maybe_resume() would
    # run before maybe_pause(), leaving the connection incorrectly paused.

    # A race condition is possible when get/get_iter() call self.frames.get()
    # without holding self.mutex. However, it's harmless — and even beneficial!
    # It can only result in popping an item from the queue before maybe_resume()
    # runs and skipping a pause() - resume() cycle that would otherwise occur.

    def maybe_pause(self) -> None:
        """Pause the writer if queue is above the high water mark."""
        # Skip if flow control is disabled.
        if self.high is None:
            return

        assert self.mutex.locked()

        # Check for "> high" to support high = 0.
        if self.frames.qsize() > self.high and not self.paused:
            self.paused = True
            self.pause()

    def maybe_resume(self) -> None:
        """Resume the writer if queue is below the low water mark."""
        # Skip if flow control is disabled.
        if self.low is None:
            return

        assert self.mutex.locked()

        # Check for "<= low" to support low = 0.
        if self.frames.qsize() <= self.low and self.paused:
            self.paused = False
            self.resume()

    def close(self) -> None:
        """
        End the stream of frames.

        Calling :meth:`close` concurrently with :meth:`get`, :meth:`get_iter`,
        or :meth:`put` is safe. They will raise :exc:`EOFError`.

        """
        with self.mutex:
            if self.closed:
                return

            self.closed = True

            if self.get_in_progress:
                # Unblock get() or get_iter().
                self.frames.put(None)

            if self.paused:
                # Unblock recv_events().
                self.paused = False
                self.resume()
