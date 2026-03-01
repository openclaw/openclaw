import { useRef } from "react";

export const useStaticDebounce = (delay: number = 500) => {
  const lastUpdateTime = useRef(new Date());

  return (cb: () => void) => {
    if (new Date().getTime() - lastUpdateTime.current.getTime() > delay) {
      cb();
      lastUpdateTime.current = new Date();
    }
  };
};
