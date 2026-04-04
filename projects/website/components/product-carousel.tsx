"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import type { NotionProduct } from "@/lib/notion";
import Link from "next/link";

export function ProductCarousel() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [language, setLanguage] = useState<"en" | "zh">("en");
  const [products, setProducts] = useState<NotionProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const response = await fetch("/api/products");
        const data = await response.json();
        if (data.success) {
          setProducts(data.data.filter(({ featured }) => featured === true));
        }
      } catch (error) {
        console.error("Error fetching products:", error);
        setProducts([]);
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, []);

  const nextSlide = () => {
    setCurrentIndex((prevIndex) => (prevIndex + 1) % products.length);
  };

  const prevSlide = () => {
    setCurrentIndex(
      (prevIndex) => (prevIndex - 1 + products.length) % products.length
    );
  };

  // Auto-advance carousel
  useEffect(() => {
    if (products.length > 0) {
      const timer = setInterval(nextSlide, 5000);
      return () => clearInterval(timer);
    }
  }, [products.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 sm:h-64">
        <div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-b-2 border-primary animate-glow"></div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="text-center py-8 sm:py-12 animate-fade-in">
        <p className="text-muted-foreground text-sm sm:text-base">
          No featured products available at the moment.
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="overflow-hidden rounded-lg">
        <div
          className="flex transition-transform duration-500 ease-in-out"
          style={{ transform: `translateX(-${currentIndex * 100}%)` }}
        >
          {products.map((product) => (
            <Link
              key={product.id}
              className="w-full flex-shrink-0"
              href={`/products/${product.id}`}
              prefetch
            >
              <Card className="border-0 bg-card/50 backdrop-blur hover-lift">
                <CardContent className="p-0">
                  <div className="grid lg:grid-cols-2 gap-0">
                    <div className="relative h-48 sm:h-64 lg:h-80 overflow-hidden">
                      <img
                        src={product.image || "/placeholder.svg"}
                        alt={product.zh_name}
                        className="h-full w-full object-cover transition-transform duration-300 hover:scale-105"
                      />
                      {/* <div className="absolute top-3 sm:top-4 right-3 sm:right-4 bg-primary text-primary-foreground px-2 py-1 rounded-full text-xs sm:text-sm font-medium animate-glow">
                        Featured
                      </div> */}
                    </div>
                    <div className="p-4 sm:p-6 lg:p-8 flex flex-col justify-center">
                      <div className="flex items-center gap-2 mb-2">
                        {/* <div className="flex items-center">
                          {[...Array(5)].map((_, i) => (
                            <Star
                              key={i}
                              className={`h-3 w-3 sm:h-4 sm:w-4 transition-colors duration-200 ${
                                i < Math.floor(product.rating) ? "fill-primary text-primary" : "text-muted-foreground"
                              }`}
                            />
                          ))}
                        </div>
                        <span className="text-xs sm:text-sm text-muted-foreground">({product.rating})</span> */}
                      </div>
                      <h3 className="font-heading text-lg sm:text-xl lg:text-2xl font-bold mb-2 sm:mb-3">
                        【{String(product.course_id).padStart(3, '0')}】{product.zh_name}
                      </h3>
                      <p className="text-muted-foreground mb-3 sm:mb-4 text-sm sm:text-base line-clamp-2 sm:line-clamp-none">
                        {product.zh_description}
                      </p>
                      {/* <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
                        <span className="font-heading text-lg sm:text-xl font-bold text-primary">{product.price}</span>
                        <Button className="bg-primary hover:bg-primary/90 w-full sm:w-auto text-sm hover-lift hover-glow">
                          {language === "en" ? "Add to Cart" : "加入購物車"}
                        </Button>
                      </div> */}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* Navigation buttons - hidden on mobile */}
      <Button
        variant="outline"
        size="icon"
        className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 bg-background/80 backdrop-blur hidden sm:flex hover-lift"
        onClick={prevSlide}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 bg-background/80 backdrop-blur hidden sm:flex hover-lift"
        onClick={nextSlide}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {/* Dots indicator */}
      <div className="flex justify-center gap-1.5 sm:gap-2 mt-4 sm:mt-6">
        {products.map((_, index) => (
          <button
            key={index}
            className={`h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full transition-all duration-300 hover:scale-125 ${
              index === currentIndex
                ? "bg-primary animate-glow"
                : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
            }`}
            onClick={() => setCurrentIndex(index)}
          />
        ))}
      </div>
    </div>
  );
}
