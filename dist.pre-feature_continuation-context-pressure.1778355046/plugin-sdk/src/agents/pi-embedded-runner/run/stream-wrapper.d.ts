import { streamSimple } from "@mariozechner/pi-ai";
type SimpleStream = ReturnType<typeof streamSimple>;
export declare function wrapStreamObjectEvents(stream: SimpleStream, onEvent: (event: Record<string, unknown>) => void | Promise<void>): SimpleStream;
export {};
