import { onSettled } from "solid-js";

/** Keep element identity with its keyed Solid row, including disposal before first commit. */
export function createElementRefs<Element extends HTMLElement>() {
  const elements = new Map<string, Element>();
  return {
    get: (key: string) => elements.get(key),
    ref: (readKey: () => string) => {
      let element: Element;
      onSettled(() => {
        const key = readKey();
        elements.set(key, element);
        return () => {
          if (elements.get(key) === element) {
            elements.delete(key);
          }
        };
      });
      return (next: Element) => {
        element = next;
      };
    },
  };
}
