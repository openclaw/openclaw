import type {
	saveMatrixCredentials as saveMatrixCredentialsType,
	touchMatrixCredentials as touchMatrixCredentialsType,
} from "./credentials.js";

export async function saveMatrixCredentials(
	...args: Parameters<typeof saveMatrixCredentialsType>
): ReturnType<typeof saveMatrixCredentialsType> {
	const runtime = await import("./credentials.js");
	return runtime.saveMatrixCredentials(...args);
}

export async function touchMatrixCredentials(
	...args: Parameters<typeof touchMatrixCredentialsType>
): ReturnType<typeof touchMatrixCredentialsType> {
	const runtime = await import("./credentials.js");
	return runtime.touchMatrixCredentials(...args);
}
