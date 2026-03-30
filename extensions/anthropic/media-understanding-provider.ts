import {
	describeImagesWithModel,
	describeImageWithModel,
	type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const anthropicMediaUnderstandingProvider: MediaUnderstandingProvider = {
	id: "anthropic",
	capabilities: ["image"],
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel,
};
