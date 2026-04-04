'use client'

import { useEffect, useRef } from 'react'

export default function ScrollBottomDetector() {
  const ref = useRef<HTMLDivElement>(null)
  const triggered = useRef(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !triggered.current) {
            triggered.current = true
            if (typeof window !== 'undefined' && (window as any).trackScrollToBottom) {
              (window as any).trackScrollToBottom()
            }
          }
        })
      },
      { threshold: 0.1 }
    )

    if (ref.current) {
      observer.observe(ref.current)
    }

    return () => observer.disconnect()
  }, [])

  return <div ref={ref} className="h-1" />
}
