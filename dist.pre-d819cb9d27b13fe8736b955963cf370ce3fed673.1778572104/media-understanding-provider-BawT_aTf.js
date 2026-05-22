import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-i4R_TfSt.js";
import "./media-understanding-DV9QwnOb.js";
//#region extensions/openrouter/media-understanding-provider.ts
const openrouterMediaUnderstandingProvider = {
	id: "openrouter",
	capabilities: ["image"],
	defaultModels: { image: "auto" },
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
export { openrouterMediaUnderstandingProvider as t };
