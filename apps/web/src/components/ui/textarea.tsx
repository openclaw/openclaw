import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, autoComplete, autoCorrect, autoCapitalize, spellCheck, ...props }, ref) => {
  const resolvedAutoComplete = autoComplete ?? "off";
  const resolvedAutoCorrect = autoCorrect ?? "off";
  const resolvedAutoCapitalize = autoCapitalize ?? "off";
  const resolvedSpellCheck = spellCheck ?? false;

  return (
    <textarea
      autoComplete={resolvedAutoComplete}
      autoCorrect={resolvedAutoCorrect}
      autoCapitalize={resolvedAutoCapitalize}
      spellCheck={resolvedSpellCheck}
      inputMode="text"
      data-form-type="other"
      data-lpignore="true"
      data-1p-ignore="true"
      data-ms-editor="false"
      className={cn(
        "flex min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
