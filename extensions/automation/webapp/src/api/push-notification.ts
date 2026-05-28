export type PushPermissionState = NotificationPermission | "unsupported";

export function isPushNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getPushNotificationPermission(): PushPermissionState {
  if (!isPushNotificationSupported()) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestPushNotificationPermission(): Promise<PushPermissionState> {
  if (!isPushNotificationSupported()) {
    return "unsupported";
  }
  return Notification.requestPermission();
}

export async function showPushNotificationPreview(title: string, body: string): Promise<boolean> {
  if (!isPushNotificationSupported()) {
    return false;
  }

  const permission = getPushNotificationPermission();
  if (permission !== "granted") {
    return false;
  }

  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await registration.showNotification(title, { body });
      return true;
    }
  }

  const notification = new Notification(title, { body });
  setTimeout(() => notification.close(), 5000);
  return true;
}
