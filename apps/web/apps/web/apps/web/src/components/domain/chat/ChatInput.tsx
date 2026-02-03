"use client";

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Send, Mic, Paperclip } from "lucide-react";

interface ChatInputProps {
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  showAttachment?: boolean;
  showVoice?: boolean;
  className?: string;
}

export function ChatInput({
  value = "",
  onChange,
  onSubmit,
  placeholder = "Type a message...",
  disabled = false,
  showAttachment = true,
  showVoice = true,
  className,
}: ChatInputProps) {
  const [internalValue, setInternalValue] = React.useState(value);
  const currentValue = onChange ? value : internalValue;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    if (onChange) {onChange(newValue);}
    else {setInternalValue(newValue);}
  };

  const handleSubmit = () => {
    if (currentValue.trim() && onSubmit) {
      onSubmit(currentValue.trim());
      if (!onChange) {setInternalValue("");}
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={cn("flex items-end gap-2 p-4 border-t border-border bg-background", className)}>
      {showAttachment && (
        <Button type="button" variant="ghost" size="icon" className="shrink-0 h-10 w-10 rounded-full" disabled={disabled}>
          <Paperclip className="h-5 w-5" />
        </Button>
      )}
      <div className="relative flex-1">
        <Textarea
          value={currentValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="min-h-[44px] max-h-32 resize-none rounded-2xl pr-12 py-3"
        />
      </div>
      {showVoice && !currentValue.trim() && (
        <Button type="button" variant="ghost" size="icon" className="shrink-0 h-10 w-10 rounded-full" disabled={disabled}>
          <Mic className="h-5 w-5" />
        </Button>
      )}
      {currentValue.trim() && (
        <Button type="button" onClick={handleSubmit} size="icon" className="shrink-0 h-10 w-10 rounded-full" disabled={disabled}>
          <Send className="h-5 w-5" />
        </Button>
      )}
    </div>
  );
}
