/** Telegram WebApp SDK type helpers. */

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: Record<string, unknown>;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  MainButton: TelegramMainButton;
  BackButton: TelegramBackButton;
  close: () => void;
  ready: () => void;
  expand: () => void;
  onEvent: (event: string, cb: () => void) => void;
  offEvent: (event: string, cb: () => void) => void;
  CloudStorage: TelegramCloudStorage;
}

export interface TelegramMainButton {
  text: string;
  color: string;
  textColor: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText: (text: string) => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
}

export interface TelegramBackButton {
  isVisible: boolean;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
}

export interface TelegramCloudStorage {
  setItem: (key: string, value: string, cb?: (err: Error | null, ok?: boolean) => void) => void;
  getItem: (key: string, cb: (err: Error | null, value?: string) => void) => void;
  removeItem: (key: string, cb?: (err: Error | null, ok?: boolean) => void) => void;
}

/** Get the Telegram WebApp instance from the global scope. */
export function getTelegramWebApp(): TelegramWebApp {
  const win = window as unknown as { Telegram?: { WebApp?: TelegramWebApp } };
  if (!win.Telegram?.WebApp) {
    throw new Error("Telegram WebApp SDK not available");
  }
  return win.Telegram.WebApp;
}

/** Promisified CloudStorage.getItem. */
export function cloudStorageGet(key: string): Promise<string | null> {
  const wa = getTelegramWebApp();
  return new Promise((resolve) => {
    wa.CloudStorage.getItem(key, (err, value) => {
      if (err || !value) resolve(null);
      else resolve(value);
    });
  });
}

/** Promisified CloudStorage.setItem. */
export function cloudStorageSet(key: string, value: string): Promise<void> {
  const wa = getTelegramWebApp();
  return new Promise((resolve, reject) => {
    wa.CloudStorage.setItem(key, value, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
