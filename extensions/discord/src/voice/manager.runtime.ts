import {
  DiscordVoiceManager as DiscordVoiceManagerImpl,
  DiscordVoiceReadyListener as DiscordVoiceReadyListenerImpl,
} from "./manager.js";
import {
  DiscordVoiceServerUpdateBridge as DiscordVoiceServerUpdateBridgeImpl,
  DiscordVoiceStateUpdateBridge as DiscordVoiceStateUpdateBridgeImpl,
} from "./adapter-bridge.js";

export class DiscordVoiceManager extends DiscordVoiceManagerImpl {}

export class DiscordVoiceReadyListener extends DiscordVoiceReadyListenerImpl {}

export class DiscordVoiceServerUpdateBridge extends DiscordVoiceServerUpdateBridgeImpl {}

export class DiscordVoiceStateUpdateBridge extends DiscordVoiceStateUpdateBridgeImpl {}
