// Discord gateway listeners for thread auto-naming.
import {
  MessageCreateListener,
  ThreadCreateListener,
  ThreadDeleteListener,
  ThreadUpdateListener,
  type Client,
} from "../internal/discord.js";
import { DiscordThreadAutoNamer } from "./thread-auto-name.js";

export class DiscordAutoNameThreadCreateListener extends ThreadCreateListener {
  constructor(private readonly namer: DiscordThreadAutoNamer) {
    super();
  }

  handle(data: Parameters<ThreadCreateListener["handle"]>[0]): void {
    try {
      this.namer.onThreadCreate(data);
    } catch {
      // Optional naming must never interrupt Discord gateway event delivery.
    }
  }
}

export class DiscordAutoNameMessageCreateListener extends MessageCreateListener {
  constructor(private readonly namer: DiscordThreadAutoNamer) {
    super();
  }

  handle(data: Parameters<MessageCreateListener["handle"]>[0], client: Client): void {
    try {
      // A model turn must not hold the ordered gateway event queue.
      void this.namer.onMessage(data, client);
    } catch {
      // Optional naming must never interrupt Discord gateway event delivery.
    }
  }
}

export class DiscordAutoNameThreadUpdateListener extends ThreadUpdateListener {
  constructor(private readonly namer: DiscordThreadAutoNamer) {
    super();
  }

  handle(data: Parameters<ThreadUpdateListener["handle"]>[0]): void {
    try {
      this.namer.onThreadUpdate(data);
    } catch {
      // An unavailable state store only disables this optional rename.
    }
  }
}

export class DiscordAutoNameThreadDeleteListener extends ThreadDeleteListener {
  constructor(private readonly namer: DiscordThreadAutoNamer) {
    super();
  }

  handle(data: Parameters<ThreadDeleteListener["handle"]>[0]): void {
    this.namer.onThreadDelete(data.id);
  }
}
