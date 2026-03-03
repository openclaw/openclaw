import { createSocket } from "node:dgram";
function pad(n) {
    return Math.ceil(n / 4) * 4;
}
function sendChatbox(text) {
    const socket = createSocket("udp4");
    const address = "/chatbox/input";
    const addressPad = pad(address.length + 1);
    const addressBuf = Buffer.alloc(addressPad);
    addressBuf.write(address, 0, "ascii");
    const typeTags = ",sTF";
    const typePad = pad(typeTags.length + 1);
    const typeBuf = Buffer.alloc(typePad);
    typeBuf.write(typeTags, 0, "ascii");
    const textPad = pad(Buffer.byteLength(text, "utf8") + 1);
    const textBuf = Buffer.alloc(textPad);
    textBuf.write(text, 0, "utf8");
    // Immediate: True (T), Notification: False (F)
    const truePad = pad(2); // "T\0"
    const trueBuf = Buffer.alloc(truePad);
    trueBuf.write("T", 0, "ascii");
    const falsePad = pad(2); // "F\0"
    const falseBuf = Buffer.alloc(falsePad);
    falseBuf.write("F", 0, "ascii");
    const buffer = Buffer.concat([addressBuf, typeBuf, textBuf]);
    console.log(`Sending to VRChat Chatbox: ${text}`);
    socket.send(buffer, 0, buffer.length, 9000, "127.0.0.1", (err) => {
        if (err) {
            console.error(err);
        }
        socket.close();
    });
}
const msg = process.argv[2] || "テスト";
sendChatbox(msg);
