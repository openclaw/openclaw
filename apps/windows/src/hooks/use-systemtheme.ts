import { useEffect, useState } from "react";

export function useSystemTheme() {
  const getTheme = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";

  const [theme, setTheme] = useState(getTheme());

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const listener = () => setTheme(media.matches ? "dark" : "light");

    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  return theme;
}
