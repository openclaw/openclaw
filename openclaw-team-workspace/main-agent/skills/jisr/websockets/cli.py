from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Generator

from .asyncio.client import ClientConnection, connect
from .asyncio.messages import SimpleQueue
from .exceptions import ConnectionClosed
from .frames import Close
from .streams import StreamReader
from .version import version as websockets_version


__all__ = ["main"]


def print_during_input(string: str) -> None:
    sys.stdout.write(
        # Save cursor position
        "\N{ESC}7"
        # Add a new line
        "\N{LINE FEED}"
        # Move cursor up
        "\N{ESC}[A"
        # Insert blank line, scroll last line down
        "\N{ESC}[L"
        # Print string in the inserted blank line
        f"{string}\N{LINE FEED}"
        # Restore cursor position
        "\N{ESC}8"
        # Move cursor down
        "\N{ESC}[B"
    )
    sys.stdout.flush()


def print_over_input(string: str) -> None:
    sys.stdout.write(
        # Move cursor to beginning of line
        "\N{CARRIAGE RETURN}"
        # Delete current line
        "\N{ESC}[K"
        # Print string
        f"{string}\N{LINE FEED}"
    )
    sys.stdout.flush()


class ReadLines(asyncio.Protocol):
    def __init__(self) -> None:
        self.reader = StreamReader()
        self.messages: SimpleQueue[str] = SimpleQueue()

    def parse(self) -> Generator[None, None, None]:
        while True:
            sys.stdout.write("> ")
            sys.stdout.flush()
            line = yield from self.reader.read_line(sys.maxsize)
            self.messages.put(line.decode().rstrip("\r\n"))

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.parser = self.parse()
        next(self.parser)

    def data_received(self, data: bytes) -> None:
        self.reader.feed_data(data)
        next(self.parser)

    def eof_received(self) -> None:
        self.reader.feed_eof()
        # next(self.parser) isn't useful and would raise EOFError.

    def connection_lost(self, exc: Exception | None) -> None:
        self.reader.discard()
        self.messages.abort()


async def print_incoming_messages(websocket: ClientConnection) -> None:
    async for message in websocket:
        if isinstance(message, str):
            print_during_input("< " + message)
        else:
            print_during_input("< (binary) " + message.hex())


async def send_outgoing_messages(
    websocket: ClientConnection,
    messages: SimpleQueue[str],
) -> None:
    while True:
        try:
            message = await messages.get()
        except EOFError:
            break
        try:
            await websocket.send(message)
        except ConnectionClosed:  # pragma: no cover
            break


async def interactive_client(uri: str) -> None:
    try:
        websocket = await connect(uri)
    except Exception as exc:
        print(f"Failed to connect to {uri}: {exc}.")
        sys.exit(1)
    else:
        print(f"Connected to {uri}.")

    loop = asyncio.get_running_loop()
    transport, protocol = await loop.connect_read_pipe(ReadLines, sys.stdin)
    incoming = asyncio.create_task(
        print_incoming_messages(websocket),
    )
    outgoing = asyncio.create_task(
        send_outgoing_messages(websocket, protocol.messages),
    )
    try:
        await asyncio.wait(
            [incoming, outgoing],
            # Clean up and exit when the server closes the connection
            # or the user enters EOT (^D), whichever happens first.
            return_when=asyncio.FIRST_COMPLETED,
        )
    # asyncio.run() cancels the main task when the user triggers SIGINT (^C).
    # https://docs.python.org/3/library/asyncio-runner.html#handling-keyboard-interruption
    # Clean up and exit without re-raising CancelledError to prevent Python
    # from raising KeyboardInterrupt and displaying a stack track.
    except asyncio.CancelledError:  # pragma: no cover
        pass
    finally:
        incoming.cancel()
        outgoing.cancel()
        transport.close()

    await websocket.close()
    assert websocket.close_code is not None and websocket.close_reason is not None
    close_status = Close(websocket.close_code, websocket.close_reason)
    print_over_input(f"Connection closed: {close_status}.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="websockets",
        description="Interactive WebSocket client.",
        add_help=False,
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--version", action="store_true")
    group.add_argument("uri", metavar="<uri>", nargs="?")
    args = parser.parse_args(argv)

    if args.version:
        print(f"websockets {websockets_version}")
        return

    if args.uri is None:
        parser.print_usage()
        sys.exit(2)

    # Enable VT100 to support ANSI escape codes in Command Prompt on Windows.
    # See https://github.com/python/cpython/issues/74261 for why this works.
    if sys.platform == "win32":
        os.system("")

    try:
        import readline  # noqa: F401
    except ImportError:  # readline isn't available on all platforms
        pass

    # Remove the try/except block when dropping Python < 3.11.
    try:
        asyncio.run(interactive_client(args.uri))
    except KeyboardInterrupt:  # pragma: no cover
        pass
