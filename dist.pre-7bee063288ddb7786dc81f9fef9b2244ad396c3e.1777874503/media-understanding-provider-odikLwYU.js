import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-8EFxT11h.js";
import "./media-understanding-CTSqwZ5v.js";
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
