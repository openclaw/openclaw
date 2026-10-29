//! Channel implementations: Telegram, Discord, and generic HTTP webhook channels.

pub mod discord;
pub mod http;
pub mod registry;
pub mod telegram;

pub use discord::DiscordChannel;
pub use http::HttpChannel;
pub use registry::{
    channel_spec, ChannelRegistry, ChannelSpec, ChannelSupport, CHANNEL_CATALOG,
};
pub use telegram::TelegramChannel;
