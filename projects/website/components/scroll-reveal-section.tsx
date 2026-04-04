"use client"

import type React from "react"

import { useEffect, useRef, useState } from "react"

interface ScrollRevealSectionProps {
  children: React.ReactNode
  className?: string
  delay?: number
}

export function ScrollRevealSection({ children, className = "", delay = 0 }: ScrollRevealSectionProps) {
  const [isVisible, setIsVisible] = useState(false)
  const sectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => {
            setIsVisible(true)
          }, delay)
        }
      },
      {
        threshold: 0.1,
        rootMargin: "-50px 0px",
      },
    )

    if (sectionRef.current) {
      observer.observe(sectionRef.current)
    }

    return () => {
      if (sectionRef.current) {
        observer.unobserve(sectionRef.current)
      }
    }
  }, [delay])

  return (
    <div
      ref={sectionRef}
      className={`transition-all duration-1000 ease-out ${
        isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-16 scale-95"
      } ${className}`}
    >
      <div
        className={`relative transition-all duration-1200 ease-out ${
          isVisible ? "transform-none" : "perspective-1000 rotateX-12"
        }`}
      >
        {/* Background reveal effect */}
        <div
          className={`absolute inset-0 -z-10 transition-all duration-1000 ease-out ${
            isVisible
              ? "bg-gradient-to-br from-primary/5 via-transparent to-accent/5 opacity-100 scale-100"
              : "bg-gradient-to-br from-primary/20 via-transparent to-accent/20 opacity-0 scale-110"
          } rounded-3xl blur-xl`}
        />

        {/* Content container with box opening effect */}
        <div
          className={`relative transition-all duration-800 ease-out ${
            isVisible ? "transform-none" : "perspective-1000 rotateX-8 translateZ--50"
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
