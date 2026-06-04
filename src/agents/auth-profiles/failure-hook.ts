export type AuthProfileFailureHook = () => void;

let authProfileFailureHook: AuthProfileFailureHook | undefined;

export function setAuthProfileFailureHook(hook: AuthProfileFailureHook | undefined): void {
  authProfileFailureHook = hook;
}

export function notifyAuthProfileFailureHook(): void {
  authProfileFailureHook?.();
}
