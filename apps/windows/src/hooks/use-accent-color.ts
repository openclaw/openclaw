import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AccentColor {
  r: u8;
  g: u8;
  b: u8;
  hex: string;
}

type u8 = number;

export function useAccentColor() {
  const [accentColor, setAccentColor] = useState<AccentColor | null>(null);

  useEffect(() => {
    const fetchAccent = async () => {
      try {
        const color = await invoke<AccentColor>("get_accent_color");
        setAccentColor(color);
      } catch (err) {
        console.error("Failed to fetch accent color:", err);
      }
    };

    fetchAccent();
  }, []);

  return accentColor;
}
