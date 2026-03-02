import { socket } from '@kit.NetworkKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { webSocket } from '@kit.NetworkKit';

/**
 * A raw TCP-based WebSocket implementation designed to bypass 
 * HarmonyOS NETSTACK bugs related to Origin header injection and port-stripping.
 */
export class RawWebSocket {
  private socket: socket.TCPSocket | socket.TLSSocket | null = null;
  private isHandshakeComplete = false;
  private isTls = false;
  private base64 = new util.Base64Helper();
  
  private onOpenCallback?: (err: BusinessError | undefined, value: Object | undefined) => void;
  private onMessageCallback?: (err: BusinessError | undefined, value: string | ArrayBuffer | undefined) => void;
  private onCloseCallback?: (err: BusinessError | undefined, value: webSocket.CloseResult | undefined) => void;
  private onErrorCallback?: (err: BusinessError) => void;

  private receiveBuffer: Uint8Array = new Uint8Array(0);

  public on(event: 'open' | 'message' | 'close' | 'error', callback: Function): void {
    if (event === 'open') this.onOpenCallback = callback as (err: BusinessError | undefined, value: Object | undefined) => void;
    if (event === 'message') this.onMessageCallback = callback as (err: BusinessError | undefined, value: string | ArrayBuffer | undefined) => void;
    if (event === 'close') this.onCloseCallback = callback as (err: BusinessError | undefined, value: webSocket.CloseResult | undefined) => void;
    if (event === 'error') this.onErrorCallback = callback as (err: BusinessError) => void;
  }

  public off(event: 'open' | 'message' | 'close' | 'error', callback?: Function): void {
    if (event === 'open') this.onOpenCallback = undefined;
    if (event === 'message') this.onMessageCallback = undefined;
    if (event === 'close') this.onCloseCallback = undefined;
    if (event === 'error') this.onErrorCallback = undefined;
  }

  public async connect(url: string, options?: webSocket.WebSocketRequestOptions): Promise<boolean> {
    try {
      const isWss = url.startsWith('wss://');
      this.isTls = isWss;
      if (this.isTls) {
        this.socket = socket.constructTLSSocketInstance();
      } else {
        this.socket = socket.constructTCPSocketInstance();
      }
      
      const socketObj = this.socket as socket.TCPSocket; // Cast to base type if possible
      socketObj.on('message', (value: socket.SocketMessageInfo) => {
        this.handleTcpData(new Uint8Array(value.message));
      });
      
      socketObj.on('close', () => {
        hilog.info(0x3D00, 'RawWebSocket', "Socket closed");
        if (this.onCloseCallback) {
          this.onCloseCallback(undefined, { code: 1006, reason: 'Socket closed' });
        }
      });

      socketObj.on('error', (err: Error) => {
        hilog.error(0x3D00, 'RawWebSocket', "Socket error: " + err.message);
        if (this.onErrorCallback) {
          this.onErrorCallback(err as BusinessError);
        }
      });

      // Parse url.
      const urlRegex = /wss?:\/\/([^:/]+)(?::(\d+))?(.*)/;
      const match = url.match(urlRegex);
      if (!match) throw new Error("Invalid WebSocket URL: " + url);
      
      const host = match[1];
      const protocolPort = isWss ? 443 : 80;
      const port = match[2] ? parseInt(match[2]) : protocolPort;
      const path = match[3] || "/";

      hilog.info(0x3D00, 'RawWebSocket', `Connecting to ${host}:${port} (wss=${this.isTls})`);
      
      if (this.isTls) {
        const tlsSocket = this.socket as socket.TLSSocket;
        await tlsSocket.connect({
          address: { address: host, port: port, family: 1 },
          secureOptions: {} // Use default OS validation
        });
      } else {
        const tcpSocket = this.socket as socket.TCPSocket;
        await tcpSocket.connect({
          address: { address: host, port: port, family: 1 }
        });
      }
      
      const headerObj = options?.header as Record<string, string> | undefined;
      const defaultScheme = isWss ? 'https' : 'http';
      const customOrigin = headerObj?.['Origin'] || `${defaultScheme}://${host}:${port}`;
      const customUA = headerObj?.['User-Agent'] || 'OpenClawNode/1.0.0-dev (Android)';

      // Perform HTTP 1.1 Upgrade Handshake
      const random = cryptoFramework.createRandom();
      const nonceBlob = random.generateRandomSync(16);
      const nonceData = nonceBlob.data;
      const nonce = this.base64.encodeToStringSync(nonceData);
      
      const handshake = 
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}${match[2] ? ':' + port : ''}\r\n` +
        `Origin: ${customOrigin}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${nonce}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `User-Agent: ${customUA}\r\n\r\n`;

      hilog.info(0x3D00, 'RawWebSocket', `Sending handshake:\n${handshake}`);

      const encoder = util.TextEncoder.create('utf-8');
      const handshakeData = encoder.encodeInto(handshake).buffer;
      if (this.isTls) {
        await (this.socket as socket.TLSSocket).send(handshakeData);
      } else {
        await (this.socket as socket.TCPSocket).send({ data: handshakeData });
      }
      return true;
    } catch (err) {
      if (this.onErrorCallback) this.onErrorCallback(err as BusinessError);
      return false;
    }
  }

  private handleTcpData(data: Uint8Array) {
    const newBuf = new Uint8Array(this.receiveBuffer.length + data.length);
    newBuf.set(this.receiveBuffer);
    newBuf.set(data, this.receiveBuffer.length);
    this.receiveBuffer = newBuf;

    if (!this.isHandshakeComplete) {
      const decoder = util.TextDecoder.create('utf-8');
      const text = decoder.decodeToString(this.receiveBuffer);
      const endOfHeaders = text.indexOf('\r\n\r\n');
      if (endOfHeaders !== -1) {
        hilog.info(0x3D00, 'RawWebSocket', "Handshake received: " + text.substring(0, Math.min(text.length, 200)));
        if (text.startsWith('HTTP/1.1 101')) {
          this.isHandshakeComplete = true;
          this.receiveBuffer = this.receiveBuffer.slice(endOfHeaders + 4);
          if (this.onOpenCallback) this.onOpenCallback(undefined, undefined);
          this.processFrames();
        } else {
           hilog.error(0x3D00, 'RawWebSocket', "Handshake rejected!");
           if (this.onErrorCallback) this.onErrorCallback({ code: 1002, message: "Handshake rejected", name: "WsError" } as BusinessError);
           this.close();
        }
      }
    } else {
      this.processFrames();
    }
  }

  private processFrames() {
    while (this.receiveBuffer.length >= 2) {
      const byte1 = this.receiveBuffer[0];
      const byte2 = this.receiveBuffer[1];
      
      const fin = (byte1 & 0x80) !== 0;
      const opcode = byte1 & 0x0F;
      const masked = (byte2 & 0x80) !== 0;
      let payloadLen = byte2 & 0x7F;
      
      let headerLen = 2;
      if (payloadLen === 126) {
        if (this.receiveBuffer.length < 4) return;
        payloadLen = (this.receiveBuffer[2] << 8) | this.receiveBuffer[3];
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (this.receiveBuffer.length < 10) return;
        payloadLen = (this.receiveBuffer[6] << 24) | (this.receiveBuffer[7] << 16) | (this.receiveBuffer[8] << 8) | this.receiveBuffer[9];
        headerLen = 10;
      }

      const maskKeyOffset = headerLen;
      if (masked) headerLen += 4;

      if (this.receiveBuffer.length < headerLen + payloadLen) {
        return; // Wait for full frame
      }

      let payload = this.receiveBuffer.slice(headerLen, headerLen + payloadLen);
      
      if (masked) {
        const maskKey = this.receiveBuffer.slice(maskKeyOffset, maskKeyOffset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i] ^ maskKey[i % 4];
        }
      }

      this.receiveBuffer = this.receiveBuffer.slice(headerLen + payloadLen);

      if (opcode === 0x1) {
        const decoder = util.TextDecoder.create('utf-8');
        const text = decoder.decodeToString(payload);
        if (this.onMessageCallback) this.onMessageCallback(undefined, text);
      } else if (opcode === 0x8) {
        hilog.info(0x3D00, 'RawWebSocket', "Server sent close frame");
        if (this.onCloseCallback) this.onCloseCallback(undefined, { code: 1000, reason: 'Normal Closure' });
        this.close();
      } else if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
      }
    }
  }

  public async send(data: string | ArrayBuffer): Promise<boolean> {
    if (!this.socket || !this.isHandshakeComplete) return false;
    
    let payloadBytes: Uint8Array;
    
    if (typeof data === 'string') {
      const encoder = util.TextEncoder.create('utf-8');
      payloadBytes = encoder.encodeInto(data);
    } else {
      payloadBytes = new Uint8Array(data);
    }

    return this.sendFrame(typeof data === 'string' ? 0x1 : 0x2, payloadBytes, true);
  }
  
  private async sendFrame(opcode: number, payload: Uint8Array, mask: boolean = true): Promise<boolean> {
    const payloadLen = payload.length;
    let headerLen = 2;
    if (payloadLen > 65535) {
      headerLen = 10;
    } else if (payloadLen > 125) {
      headerLen = 4;
    }
    
    const maskKeyBytes = mask ? 4 : 0;
    const frame = new Uint8Array(headerLen + maskKeyBytes + payloadLen);
    
    frame[0] = 0x80 | opcode; 
    
    let lengthByte = payloadLen;
    if (payloadLen > 65535) {
      lengthByte = 127;
      frame[2] = 0; frame[3] = 0; frame[4] = 0; frame[5] = 0;
      frame[6] = (payloadLen >> 24) & 0xFF;
      frame[7] = (payloadLen >> 16) & 0xFF;
      frame[8] = (payloadLen >> 8) & 0xFF;
      frame[9] = payloadLen & 0xFF;
    } else if (payloadLen > 125) {
      lengthByte = 126;
      frame[2] = (payloadLen >> 8) & 0xFF;
      frame[3] = payloadLen & 0xFF;
    }
    
    frame[1] = (mask ? 0x80 : 0) | lengthByte;
    
    let payloadOffset = headerLen;
    if (mask) {
      const random = cryptoFramework.createRandom();
      const maskBlob = random.generateRandomSync(4);
      const maskKey = maskBlob.data;
      
      frame[headerLen] = maskKey[0];
      frame[headerLen+1] = maskKey[1];
      frame[headerLen+2] = maskKey[2];
      frame[headerLen+3] = maskKey[3];
      payloadOffset += 4;
      
      for (let i = 0; i < payloadLen; i++) {
        frame[payloadOffset + i] = payload[i] ^ maskKey[i % 4];
      }
    } else {
      frame.set(payload, payloadOffset);
    }
    
    try {
      if (this.socket) {
        const data = frame.buffer;
        if (this.isTls) {
           await (this.socket as socket.TLSSocket).send(data);
        } else {
           await (this.socket as socket.TCPSocket).send({ data: data });
        }
        return true;
      }
      return false;
    } catch (e) {
      hilog.error(0x3D00, 'RawWebSocket', "Send error: " + e);
      return false;
    }
  }

  public async close(code?: number, reason?: string): Promise<boolean> {
    try {
      if (this.socket) {
        if (this.isTls) {
          await (this.socket as socket.TLSSocket).close();
        } else {
          await (this.socket as socket.TCPSocket).close();
        }
        this.socket = null;
      }
      this.isHandshakeComplete = false;
      return true;
    } catch {
      return false;
    }
  }
}
