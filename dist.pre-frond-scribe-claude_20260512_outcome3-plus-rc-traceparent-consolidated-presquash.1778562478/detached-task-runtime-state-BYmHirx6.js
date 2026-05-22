//#region src/tasks/detached-task-runtime-state.ts
let detachedTaskLifecycleRuntimeRegistration;
function registerDetachedTaskLifecycleRuntime(pluginId, runtime) {
	detachedTaskLifecycleRuntimeRegistration = {
		pluginId,
		runtime
	};
}
function getDetachedTaskLifecycleRuntimeRegistration() {
	if (!detachedTaskLifecycleRuntimeRegistration) return;
	return {
		pluginId: detachedTaskLifecycleRuntimeRegistration.pluginId,
		runtime: detachedTaskLifecycleRuntimeRegistration.runtime
	};
}
function getRegisteredDetachedTaskLifecycleRuntime() {
	return detachedTaskLifecycleRuntimeRegistration?.runtime;
}
function restoreDetachedTaskLifecycleRuntimeRegistration(registration) {
	detachedTaskLifecycleRuntimeRegistration = registration ? {
		pluginId: registration.pluginId,
		runtime: registration.runtime
	} : void 0;
}
function clearDetachedTaskLifecycleRuntimeRegistration() {
	detachedTaskLifecycleRuntimeRegistration = void 0;
}
//#endregion
export { restoreDetachedTaskLifecycleRuntimeRegistration as a, registerDetachedTaskLifecycleRuntime as i, getDetachedTaskLifecycleRuntimeRegistration as n, getRegisteredDetachedTaskLifecycleRuntime as r, clearDetachedTaskLifecycleRuntimeRegistration as t };
