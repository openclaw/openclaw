import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-BLf1EUGN.js";
import "./media-understanding-ZpweQbW0.js";
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
