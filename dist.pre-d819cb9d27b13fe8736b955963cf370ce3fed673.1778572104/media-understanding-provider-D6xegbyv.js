import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-i4R_TfSt.js";
import "./media-understanding-DV9QwnOb.js";
//#region extensions/anthropic/media-understanding-provider.ts
const anthropicMediaUnderstandingProvider = {
	id: "anthropic",
	capabilities: ["image"],
	defaultModels: { image: "claude-opus-4-7" },
	autoPriority: { image: 20 },
	nativeDocumentInputs: ["pdf"],
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
export { anthropicMediaUnderstandingProvider as t };
