import { useEffect, useRef, useState } from "react";
import { makeStyles, Subtitle2, Text } from "@fluentui/react-components";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";

const useStyles = makeStyles({
  root: {
    padding: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    height: "100%",
    width: "100%",
    overflow: "hidden",
  },
});

export const NotificationScreen = () => {
  const styles = useStyles();
  const [content, setContent] = useState<{
    title: string;
    body: string;
  } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const title = params.get("title");
    const body = params.get("body") || "";
    return title ? { title, body } : null;
  });
  const initialContentRef = useRef(content);

  useEffect(() => {
    if (initialContentRef.current) {
      getCurrentWebviewWindow().show();
    }

    let timer: ReturnType<typeof setTimeout>;

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        getCurrentWebviewWindow().hide();
      }, 5000);
    };

    resetTimer();

    const unlisten = listen<{ title: string; body: string }>(
      "notification-update",
      (event) => {
        if (!event.payload.title) {
          getCurrentWebviewWindow().hide();
          return;
        }
        setContent(event.payload);
        resetTimer();
      }
    );

    return () => {
      unlisten.then((f) => f());
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!content) return null;

  return (
    <div className={styles.root}>
      <Subtitle2>{content.title}</Subtitle2>
      <Text size={200}>{content.body}</Text>
    </div>
  );
};
