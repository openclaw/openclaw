"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Paperclip, Image as ImageIcon, Mic, Square, Send, X, FileText } from "lucide-react";
import type { AgenticAttachment } from "./types";

export interface MessageComposerProps {
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  onSend: (message: { content: string; attachments: AgenticAttachment[] }) => void;
  onToggleRecording?: (recording: boolean) => void;
}

function createAttachment(file: File, kind: "image" | "file"): AgenticAttachment {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
  return { id, name: file.name, kind, file, previewUrl };
}

export function MessageComposer({
  disabled = false,
  placeholder = "Message…",
  className,
  onSend,
  onToggleRecording,
}: MessageComposerProps) {
  const [message, setMessage] = React.useState("");
  const [attachments, setAttachments] = React.useState<AgenticAttachment[]>([]);
  const [recording, setRecording] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const revoke = React.useCallback((att: AgenticAttachment) => {
    if (att.previewUrl) {URL.revokeObjectURL(att.previewUrl);}
  }, []);

  const attachmentsRef = React.useRef<AgenticAttachment[]>(attachments);
  React.useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  React.useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revoke);
    };
  }, [revoke]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) {return;}
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [message]);

  const send = () => {
    if (disabled) {return;}
    if (!message.trim() && attachments.length === 0) {return;}
    onSend({ content: message.trim(), attachments });
    setMessage("");
    setAttachments([]);
  };

  const onSelectFiles = (files: FileList | null, kind: "image" | "file") => {
    if (!files) {return;}
    const next = Array.from(files).map((f) => createAttachment(f, kind));
    setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found) {revoke(found);}
      return prev.filter((a) => a.id !== id);
    });
  };

  return (
    <div className={cn("border-t border-border bg-card/30 p-4", className)}>
      {attachments.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {attachments.map((att) => (
            <div key={att.id} className="group relative">
              {att.kind === "image" && att.previewUrl ? (
                <div className="relative">
                  <img
                    src={att.previewUrl}
                    alt={att.name}
                    className="h-16 w-16 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove attachment"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <span className="max-w-[140px] truncate text-xs text-foreground/90">
                    {att.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove attachment"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <div className="flex gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onSelectFiles(e.target.files, "file");
              e.target.value = "";
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              onSelectFiles(e.target.files, "image");
              e.target.value = "";
            }}
          />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-lg"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-lg"
            disabled={disabled}
            onClick={() => imageInputRef.current?.click()}
          >
            <ImageIcon className="size-5" />
          </Button>
          <Button
            type="button"
            variant={recording ? "destructive" : "ghost"}
            size="icon"
            className="h-10 w-10 rounded-lg"
            disabled={disabled}
            onClick={() => {
              const next = !recording;
              setRecording(next);
              onToggleRecording?.(next);
            }}
          >
            {recording ? <Square className="size-5" /> : <Mic className="size-5" />}
          </Button>
        </div>

        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="text"
            data-form-type="other"
            data-lpignore="true"
            data-1p-ignore="true"
            data-ms-editor="false"
            className={cn(
              "w-full resize-none rounded-xl border border-input bg-background px-4 py-3 text-sm",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          />
        </div>

        <Button
          type="button"
          size="icon"
          className="h-10 w-10 rounded-xl"
          disabled={disabled || (!message.trim() && attachments.length === 0)}
          onClick={send}
          aria-label="Send"
        >
          <Send className="size-5" />
        </Button>
      </div>
    </div>
  );
}
