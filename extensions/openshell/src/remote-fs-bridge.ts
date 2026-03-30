import {
	createRemoteShellSandboxFsBridge,
	type RemoteShellSandboxHandle,
	type SandboxContext,
	type SandboxFsBridge,
} from "openclaw/plugin-sdk/sandbox";

export function createOpenShellRemoteFsBridge(params: {
	sandbox: SandboxContext;
	backend: RemoteShellSandboxHandle;
}): SandboxFsBridge {
	return createRemoteShellSandboxFsBridge({
		sandbox: params.sandbox,
		runtime: params.backend,
	});
}
