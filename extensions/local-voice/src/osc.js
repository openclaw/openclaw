import { createSocket } from "node:dgram";
const DEFAULT_OSC_CONFIG = {
    host: "127.0.0.1",
    port: 9000,
    enabled: true,
};
export class OSCClient {
    config;
    socket = null;
    constructor(config) {
        this.config = { ...DEFAULT_OSC_CONFIG, ...config };
    }
    init() {
        if (!this.socket) {
            this.socket = createSocket("udp4");
            this.socket.on("error", (err) => {
                console.error("[local-voice] OSC socket error:", err.message);
            });
        }
    }
    send(message) {
        if (!this.config.enabled) {
            return;
        }
        this.init();
        const buffer = this.encodeMessage(message);
        this.socket.send(buffer, this.config.port, this.config.host, (err) => {
            if (err) {
                console.error("[local-voice] OSC send error:", err.message);
            }
        });
    }
    sendAvatarParameter(name, value) {
        this.send({
            address: `/avatar/parameters/${name}`,
            args: [value],
        });
    }
    sendChatbox(text, immediate = true) {
        this.send({
            address: "/chatbox/input",
            args: [text, immediate, false], // [text, immediate, notification_only]
        });
    }
    sendViseme(viseme) {
        this.send({
            address: "/avatar/parameters/Viseme",
            args: [viseme],
        });
    }
    close() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
    encodeMessage(message) {
        const buffers = [];
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
    getTypeTag(arg) {
        if (typeof arg === "string") {
            return "s";
        }
        if (typeof arg === "number") {
            return Number.isInteger(arg) ? "i" : "f";
        }
        return arg ? "T" : "F";
    }
    encodeArgument(arg) {
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
    padTo4(length) {
        return Math.ceil(length / 4) * 4;
    }
}
let globalClient = null;
export function getOSCClient(config) {
    if (!globalClient) {
        globalClient = new OSCClient(config);
    }
    return globalClient;
}
export function resetOSCClient() {
    if (globalClient) {
        globalClient.close();
        globalClient = null;
    }
}
