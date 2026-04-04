"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Globe } from "lucide-react"

export function LanguageToggle() {
  const [language, setLanguage] = useState<"en" | "zh">("en")

  const toggleLanguage = () => {
    setLanguage((prev) => (prev === "en" ? "zh" : "en"))
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleLanguage}
      className="flex items-center gap-2 text-muted-foreground  w-full md:w-auto justify-start md:justify-center hover:bg-gradient-to-r hover:from-orange-600 hover:to-pink-600 hover:text-white"
    >
      <Globe className="h-4 w-4 flex-shrink-0" />
      <span className="text-sm font-medium">{language === "en" ? "中文" : "EN"}</span>
    </Button>
  )
}
