import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "rounded-full border border-transparent text-sm font-medium [&_svg:not([class*='size-'])]:size-4 inline-flex items-center justify-center whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-foreground text-background shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft-hover)] hover:opacity-90",
        outline:
          "bg-card text-foreground shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft-hover)] hover:bg-muted",
        secondary:
          "bg-card text-foreground shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft-hover)]",
        ghost: "hover:bg-card hover:shadow-[var(--shadow-soft)]",
        destructive:
          "bg-card text-destructive shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft-hover)] hover:bg-card",
        link: "text-brand underline-offset-4 hover:underline",
        brand:
          "bg-brand text-brand-foreground shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-soft-hover)] hover:opacity-90",
      },
      size: {
        default: "h-12 gap-2 px-6",
        xs: "h-8 gap-1 px-3 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-10 gap-1.5 px-4",
        lg: "h-14 gap-2 px-8",
        xl: "h-[70px] gap-2 px-8 text-base",
        icon: "size-11",
        "icon-xs": "size-8 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-10",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
