export const A2UI_PATH = "/__openclaw__/a2ui";

export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

export function isA2uiPath(pathname: string): boolean {
  return pathname === A2UI_PATH || pathname.startsWith(`${A2UI_PATH}/`);
}
