"""Telegram command - manage Telegram bot."""

import asyncio
import signal

import typer

from openclaw_py.cli.utils import error_exit, info, success
from openclaw_py.config.loader import load_config_sync as load_config

telegram_app = typer.Typer(name="telegram", help="Manage Telegram bot")


@telegram_app.command(name="start")
def start_cmd() -> None:
    """Start the Telegram bot."""
    try:
        config = load_config()

        if not config.telegram or not config.telegram.token:
            error_exit("Telegram not configured. Run 'openclaw setup' to configure.")

        info("Starting Telegram bot...")
        info(f"  Bot token: {config.telegram.token[:10]}...{config.telegram.token[-4:]}")
        info("")
        info("Press Ctrl+C to stop the bot")
        info("=" * 60)

        # Run the Telegram bot
        async def run_bot():
            from openclaw_py.channels.telegram.bot import create_telegram_bot

            bot = await create_telegram_bot(config)

            # Setup signal handlers
            loop = asyncio.get_event_loop()

            def signal_handler():
                info("\n\nShutting down Telegram bot...")
                loop.stop()

            for sig in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(sig, signal_handler)

            try:
                await bot.start()
            except KeyboardInterrupt:
                pass
            finally:
                await bot.stop()

        asyncio.run(run_bot())

        success("\nTelegram bot stopped.")

    except Exception as e:
        error_exit(f"Failed to start Telegram bot: {e}")


@telegram_app.command(name="stop")
def stop_cmd() -> None:
    """Stop the Telegram bot."""
    info("Telegram bot stop not yet implemented (use Ctrl+C in the start terminal)")


@telegram_app.command(name="status")
def status_cmd() -> None:
    """Check Telegram bot status."""
    try:
        config = load_config()

        if not config.telegram or not config.telegram.token:
            info("Telegram bot: Not configured")
            info("\n💡 Configure with: openclaw setup")
            return

        info("Telegram bot configuration:")
        info(f"  Token: {config.telegram.token[:10]}...{config.telegram.token[-4:]}")
        info(f"  Configured: Yes")

        info("\n💡 Start the bot with: openclaw telegram start")

    except Exception as e:
        error_exit(f"Failed to check Telegram status: {e}")


@telegram_app.command(name="test")
def test_cmd() -> None:
    """Test Telegram bot connection."""
    try:
        config = load_config()

        if not config.telegram or not config.telegram.token:
            error_exit("Telegram not configured. Run 'openclaw setup' to configure.")

        info("Testing Telegram bot connection...")

        async def test_connection():
            from aiogram import Bot

            bot = Bot(token=config.telegram.token)
            try:
                me = await bot.get_me()
                success(f"✓ Connection successful!")
                info(f"  Bot username: @{me.username}")
                info(f"  Bot name: {me.first_name}")
                info(f"  Bot ID: {me.id}")
            except Exception as e:
                error_exit(f"Connection failed: {e}")
            finally:
                await bot.session.close()

        asyncio.run(test_connection())

    except Exception as e:
        error_exit(f"Failed to test Telegram connection: {e}")
