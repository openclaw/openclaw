// Discord gateway listeners for thread auto-naming.
import {
  GatewayDispatchEvents,
  type ListenerDataByEvent,
  type Client,
} from "../internal/discord.js";
import { DiscordThreadAutoNamer } from "./thread-auto-name.js";

export class DiscordAutoNameThreadCreateListener {
  readonly type = GatewayDispatchEvents.ThreadCreate;
  constructor(private readonly namer: DiscordThreadAutoNamer) {}

  handle(data: ListenerDataByEvent[GatewayDispatchEvents.ThreadCreate]): void {
    try {
      this.namer.onThreadCreate(data);
    } catch {
      // Optional naming must never interrupt Discord gateway event delivery.
    }
  }
}

export class DiscordAutoNameMessageCreateListener {
  readonly type = GatewayDispatchEvents.MessageCreate;
  constructor(private readonly namer: DiscordThreadAutoNamer) {}

  handle(data: ListenerDataByEvent[GatewayDispatchEvents.MessageCreate], client: Client): void {
    try {
      // A model turn must not hold the ordered gateway event queue.
      void this.namer.onMessage(data, client);
    } catch {
      // Optional naming must never interrupt Discord gateway event delivery.
    }
  }
}

export class DiscordAutoNameThreadUpdateListener {
  readonly type = GatewayDispatchEvents.ThreadUpdate;
  constructor(private readonly namer: DiscordThreadAutoNamer) {}

  handle(data: ListenerDataByEvent[GatewayDispatchEvents.ThreadUpdate]): void {
    try {
      this.namer.onThreadUpdate(data);
    } catch {
      // An unavailable state store only disables this optional rename.
    }
  }
}

export class DiscordAutoNameThreadDeleteListener {
  readonly type = GatewayDispatchEvents.ThreadDelete;
  constructor(private readonly namer: DiscordThreadAutoNamer) {}

  handle(data: ListenerDataByEvent[GatewayDispatchEvents.ThreadDelete]): void {
    this.namer.onThreadDelete(data.id);
  }
}
