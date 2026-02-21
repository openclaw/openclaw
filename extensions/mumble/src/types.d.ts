/**
 * Type declarations for modules without official types
 */

declare module "openclaw" {
  export interface OpenClawExtension {
    id: string;
    name: string;
    version: string;
    init(context: any): Promise<void>;
    cleanup(context: any): Promise<void>;
  }
}

declare module "opus-encdec" {
  export class Encoder {
    constructor(config: {
      encoderSampleRate: number;
      encoderApplication: number;
      encoderFrameSize: number;
      encoderBitRate: number;
      numberOfChannels: number;
      rawOpus: boolean;
    });
    encode(data: Float32Array[]): Promise<Uint8Array>;
  }
}

declare module "node-fetch" {
  export default function fetch(url: string, init?: any): Promise<any>;
}
