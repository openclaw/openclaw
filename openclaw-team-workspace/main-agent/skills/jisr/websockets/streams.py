from __future__ import annotations

from collections.abc import Generator


class StreamReader:
    """
    Generator-based stream reader.

    This class doesn't support concurrent calls to :meth:`read_line`,
    :meth:`read_exact`, or :meth:`read_to_eof`. Make sure calls are
    serialized.

    """

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.eof = False

    def read_line(self, m: int) -> Generator[None, None, bytearray]:
        """
        Read a LF-terminated line from the stream.

        This is a generator-based coroutine.

        The return value includes the LF character.

        Args:
            m: Maximum number bytes to read; this is a security limit.

        Raises:
            EOFError: If the stream ends without a LF.
            RuntimeError: If the stream ends in more than ``m`` bytes.

        """
        n = 0  # number of bytes to read
        p = 0  # number of bytes without a newline
        while True:
            n = self.buffer.find(b"\n", p) + 1
            if n > 0:
                break
            p = len(self.buffer)
            if p > m:
                raise RuntimeError(f"read {p} bytes, expected no more than {m} bytes")
            if self.eof:
                raise EOFError(f"stream ends after {p} bytes, before end of line")
            yield
        if n > m:
            raise RuntimeError(f"read {n} bytes, expected no more than {m} bytes")
        r = self.buffer[:n]
        del self.buffer[:n]
        return r

    def read_exact(self, n: int) -> Generator[None, None, bytearray]:
        """
        Read a given number of bytes from the stream.

        This is a generator-based coroutine.

        Args:
            n: How many bytes to read.

        Raises:
            EOFError: If the stream ends in less than ``n`` bytes.

        """
        assert n >= 0
        while len(self.buffer) < n:
            if self.eof:
                p = len(self.buffer)
                raise EOFError(f"stream ends after {p} bytes, expected {n} bytes")
            yield
        r = self.buffer[:n]
        del self.buffer[:n]
        return r

    def read_to_eof(self, m: int) -> Generator[None, None, bytearray]:
        """
        Read all bytes from the stream.

        This is a generator-based coroutine.

        Args:
            m: Maximum number bytes to read; this is a security limit.

        Raises:
            RuntimeError: If the stream ends in more than ``m`` bytes.

        """
        while not self.eof:
            p = len(self.buffer)
            if p > m:
                raise RuntimeError(f"read {p} bytes, expected no more than {m} bytes")
            yield
        r = self.buffer[:]
        del self.buffer[:]
        return r

    def at_eof(self) -> Generator[None, None, bool]:
        """
        Tell whether the stream has ended and all data was read.

        This is a generator-based coroutine.

        """
        while True:
            if self.buffer:
                return False
            if self.eof:
                return True
            # When all data was read but the stream hasn't ended, we can't
            # tell if until either feed_data() or feed_eof() is called.
            yield

    def feed_data(self, data: bytes | bytearray) -> None:
        """
        Write data to the stream.

        :meth:`feed_data` cannot be called after :meth:`feed_eof`.

        Args:
            data: Data to write.

        Raises:
            EOFError: If the stream has ended.

        """
        if self.eof:
            raise EOFError("stream ended")
        self.buffer += data

    def feed_eof(self) -> None:
        """
        End the stream.

        :meth:`feed_eof` cannot be called more than once.

        Raises:
            EOFError: If the stream has ended.

        """
        if self.eof:
            raise EOFError("stream ended")
        self.eof = True

    def discard(self) -> None:
        """
        Discard all buffered data, but don't end the stream.

        """
        del self.buffer[:]
