import { createSocket, type Socket } from "node:dgram";

export type OSCConfig = {
  host: string;
  port: number;
  enabled: boolean;
};

export type OSCMessage = {
  address: string;
  args: (string | number | boolean)[];
};

const DEFAULT_OSC_CONFIG: OSCConfig = {
  host: "127.0.0.1",
  port: 9000,
  enabled: true,
};

export class OSCClient {
  private config: OSCConfig;
  private socket: Socket | null = null;

  constructor(config?: Partial<OSCConfig>) {
    this.config = { ...DEFAULT_OSC_CONFIG, ...config };
  }

  private init(): void {
    if (!this.socket) {
      this.socket = createSocket("udp4");
      this.socket.on("error", (err) => {
        console.error("[local-voice] OSC socket error:", err.message);
      });
    }
  }

  send(message: OSCMessage): void {
    if (!this.config.enabled) {
      return;
    }

    this.init();

    const buffer = this.encodeMessage(message);
    this.socket!.send(buffer, this.config.port, this.config.host, (err) => {
      if (err) {
        console.error("[local-voice] OSC send error:", err.message);
      }
    });
  }

  sendAvatarParameter(name: string, value: boolean | number): void {
    this.send({
      address: `/avatar/parameters/${name}`,
      args: [value],
    });
  }

  sendChatbox(text: string, immediate: boolean = true): void {
    this.send({
      address: "/chatbox/input",
      args: [text, immediate, false], // [text, immediate, notification_only]
    });
  }

  sendViseme(viseme: number): void {
    this.send({
      address: "/avatar/parameters/Viseme",
      args: [viseme],
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private encodeMessage(message: OSCMessage): Buffer {
    const buffers: Buffer[] = [];

    const addressPad = this.padTo4(message.address.length + 1);
    const addressBuf = Buffer.alloc(addressPad);
    addressBuf.write(message.address, 0, "ascii");
    buffers.push(addressBuf);

    const typeTags = `,${message.args.map((arg) => this.getTypeTag(arg)).join("")}`;
    const typePad = this.padTo4(typeTags.length + 1);
    const typeBuf = Buffer.alloc(typePad);
    typeBuf.write(typeTags, 0, "ascii");
    buffers.push(typeBuf);

    for (const arg of message.args) {
      buffers.push(this.encodeArgument(arg));
    }

    return Buffer.concat(buffers);
  }

  private getTypeTag(arg: string | number | boolean): string {
    if (typeof arg === "string") {
      return "s";
    }
    if (typeof arg === "number") {
      return Number.isInteger(arg) ? "i" : "f";
    }
    return arg ? "T" : "F";
  }

  private encodeArgument(arg: string | number | boolean): Buffer {
    if (typeof arg === "string") {
      const pad = this.padTo4(arg.length + 1);
      const buf = Buffer.alloc(pad);
      buf.write(arg, 0, "ascii");
      return buf;
    }

    if (typeof arg === "number") {
      if (Number.isInteger(arg)) {
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(arg, 0);
        return buf;
      }
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(arg, 0);
      return buf;
    }

    return Buffer.alloc(0);
  }

  private padTo4(length: number): number {
    return Math.ceil(length / 4) * 4;
  }
}

let globalClient: OSCClient | null = null;

export function getOSCClient(config?: Partial<OSCConfig>): OSCClient {
  if (!globalClient) {
    globalClient = new OSCClient(config);
  }
  return globalClient;
}

export function resetOSCClient(): void {
  if (globalClient) {
    globalClient.close();
    globalClient = null;
  }
}
