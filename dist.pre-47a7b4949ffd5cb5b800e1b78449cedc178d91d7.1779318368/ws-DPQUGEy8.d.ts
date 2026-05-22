import WebSocket from "ws";

//#region src/infra/ws.d.ts
declare function rawDataToString(data: WebSocket.RawData, encoding?: BufferEncoding): string;
//#endregion
export { rawDataToString as t };