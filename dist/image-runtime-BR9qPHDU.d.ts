import { i as ImageDescriptionResult, o as ImagesDescriptionRequest, r as ImageDescriptionRequest, s as ImagesDescriptionResult } from "./types-Dp_Bsq2N.js";
import * as _$_earendil_works_pi_ai0 from "@earendil-works/pi-ai";

//#region src/media-understanding/image-runtime.d.ts
declare const describeImageWithModel: (params: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
declare const describeImagesWithModel: (params: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
declare const describeImageWithModelPayloadTransform: (params: ImageDescriptionRequest, onPayload: ((payload: unknown, model: _$_earendil_works_pi_ai0.Model<_$_earendil_works_pi_ai0.Api>) => unknown | undefined | Promise<unknown | undefined>) | undefined) => Promise<ImageDescriptionResult>;
declare const describeImagesWithModelPayloadTransform: (params: ImagesDescriptionRequest, onPayload: ((payload: unknown, model: _$_earendil_works_pi_ai0.Model<_$_earendil_works_pi_ai0.Api>) => unknown | undefined | Promise<unknown | undefined>) | undefined) => Promise<ImagesDescriptionResult>;
//#endregion
export { describeImagesWithModelPayloadTransform as i, describeImageWithModelPayloadTransform as n, describeImagesWithModel as r, describeImageWithModel as t };