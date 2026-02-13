import dgram from "node:dgram";
import type { AriClient } from "./ari-client.js";
import type { AriBridge, AriChannel, AriConfig } from "./types.js";

export type MediaGraph = {
  bridgeId: string;
  sipChannelId: string;
  extChannelId: string;
  sttExtChannelId: string;
  snoopChannelId: string;
  sttBridgeId?: string;
  rtpPort: number;
  sttRtpPort: number;
  udp: dgram.Socket;
  sttUdp: dgram.Socket;
};

export class AriMedia {
  private cfg: AriConfig;
  private client: AriClient;
  private nextRtpPort: number;
  private baseRtpPort: number;

  constructor(cfg: AriConfig, client: AriClient) {
    this.cfg = cfg;
    this.client = client;
    this.baseRtpPort = cfg.rtpPort;
    this.nextRtpPort = cfg.rtpPort;
  }

  async createMediaGraph(params: { sipChannelId: string }): Promise<MediaGraph> {
    const udp = dgram.createSocket("udp4");
    const sttUdp = dgram.createSocket("udp4");

    let rtpPort = 0;
    let sttRtpPort = 0;

    let bridgeId = "";
    let sttBridgeId = "";
    let extChannelId = "";
    let sttExtChannelId = "";
    let snoopChannelId = "";

    try {
      rtpPort = await this.allocatePort(udp);
      sttRtpPort = await this.allocatePort(sttUdp);

      const bridge = await this.client.createBridge("mixing");
      bridgeId = bridge.id;
      const externalHost = `${this.cfg.rtpHost}:${rtpPort}`;
      const sttExternalHost = `${this.cfg.rtpHost}:${sttRtpPort}`;
      console.log("[ari] media graph", {
        rtpHost: this.cfg.rtpHost,
        externalHost,
        sttExternalHost,
        rtpPort,
        sttRtpPort,
        bridgeId,
      });

      const ext = await this.client.createExternalMedia({
        app: this.cfg.app,
        externalHost,
        format: this.cfg.codec,
        direction: "both",
        encapsulation: "rtp",
        transport: "udp",
      });
      extChannelId = ext.id;

      const sttExt = await this.client.createExternalMedia({
        app: this.cfg.app,
        externalHost: sttExternalHost,
        format: this.cfg.codec,
        direction: "out",
        encapsulation: "rtp",
        transport: "udp",
      });
      sttExtChannelId = sttExt.id;

      try {
        await this.client.addChannelsToBridge(bridgeId, [params.sipChannelId, extChannelId]);
      } catch (err) {
        console.warn("[ari] addChannelsToBridge failed, retrying", err);
        await this.client.addChannelsToBridge(bridgeId, [params.sipChannelId, extChannelId]);
      }
      try {
        const b = await this.client.getBridge(bridgeId);
        console.log("[ari] bridge state", { bridgeId, channels: (b as AriBridge).channels });
      } catch (err) {
        console.warn("[ari] bridge state fetch failed", err);
      }

      const snoop = await this.client.createSnoop({
        app: this.cfg.app,
        channelId: params.sipChannelId,
        spy: "in",
        whisper: "none",
        appArgs: "snoop",
      });
      snoopChannelId = snoop.id;

      const sttBridge = await this.client.createBridge("mixing");
      sttBridgeId = sttBridge.id;
      await this.client.addChannelToBridge(sttBridgeId, snoopChannelId);
      await this.client.addChannelToBridge(sttBridgeId, sttExtChannelId);
      try {
        const sb = await this.client.getBridge(sttBridgeId);
        console.log("[ari] stt bridge state", {
          sttBridgeId,
          channels: (sb as AriBridge).channels,
        });
      } catch (err) {
        console.warn("[ari] stt bridge state fetch failed", err);
      }

      return {
        bridgeId,
        sttBridgeId,
        sipChannelId: params.sipChannelId,
        extChannelId,
        sttExtChannelId,
        snoopChannelId,
        rtpPort,
        sttRtpPort,
        udp,
        sttUdp,
      };
    } catch (err) {
      await this.safeTeardown({
        bridgeId,
        sttBridgeId,
        sipChannelId: params.sipChannelId,
        extChannelId,
        sttExtChannelId,
        snoopChannelId,
        rtpPort,
        sttRtpPort,
        udp,
        sttUdp,
      });
      throw err;
    }
  }

  async teardown(graph: MediaGraph): Promise<void> {
    await this.safeTeardown(graph);
  }

  private async safeTeardown(graph: MediaGraph): Promise<void> {
    try {
      graph.udp?.close();
    } catch {}
    try {
      graph.sttUdp?.close();
    } catch {}

    if (graph.extChannelId) await this.client.safeHangupChannel(graph.extChannelId).catch(() => {});
    if (graph.sttExtChannelId)
      await this.client.safeHangupChannel(graph.sttExtChannelId).catch(() => {});
    if (graph.snoopChannelId)
      await this.client.safeHangupChannel(graph.snoopChannelId).catch(() => {});

    if (graph.bridgeId) await this.client.deleteBridge(graph.bridgeId).catch(() => {});
    if (graph.sttBridgeId) await this.client.deleteBridge(graph.sttBridgeId).catch(() => {});
  }

  private async allocatePort(socket: dgram.Socket): Promise<number> {
    const maxPort = 65535;
    for (let i = 0; i < 20; i++) {
      if (this.nextRtpPort > maxPort) {
        console.warn("[ari] RTP port exceeded max, wrapping", {
          nextRtpPort: this.nextRtpPort,
          baseRtpPort: this.baseRtpPort,
        });
        this.nextRtpPort = this.baseRtpPort;
      }
      const candidate = this.nextRtpPort++;
      try {
        await this.bindUdp(socket, candidate);
        return candidate;
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") throw err;
      }
    }
    await this.bindUdp(socket, 0);
    return (socket.address() as any).port;
  }

  private async bindUdp(udp: dgram.Socket, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: unknown) => {
        udp.off("listening", onListening);
        udp.off("error", onError);
        reject(err);
      };
      const onListening = () => {
        udp.off("error", onError);
        resolve();
      };
      udp.once("error", onError);
      udp.once("listening", onListening);
      udp.bind(port, "0.0.0.0");
    });
  }
}
