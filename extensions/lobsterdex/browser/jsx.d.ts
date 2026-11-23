import "@solidjs/web";

declare module "@solidjs/web" {
  namespace JSX {
    interface SVGAttributes<T> {
      "xml:space"?: "default" | "preserve";
    }
  }
}
