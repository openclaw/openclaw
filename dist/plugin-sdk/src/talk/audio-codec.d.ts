export declare function resamplePcm(input: Buffer, inputSampleRate: number, outputSampleRate: number): Buffer;
export declare function resamplePcmTo8k(input: Buffer, inputSampleRate: number): Buffer;
export declare function pcmToMulaw(pcm: Buffer): Buffer;
export declare function mulawToPcm(mulaw: Buffer): Buffer;
export declare function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer;
