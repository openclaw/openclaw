class DiscordSendError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = "DiscordSendError";
    if (opts) {
      Object.assign(this, opts);
    }
  }
  toString() {
    return this.message;
  }
}
const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
const DISCORD_MAX_STICKER_BYTES = 512 * 1024;
export {
  DISCORD_MAX_EMOJI_BYTES,
  DISCORD_MAX_STICKER_BYTES,
  DiscordSendError
};
