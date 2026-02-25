"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

export function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="mb-6 flex gap-2 border-b pb-4">
      <Link href="/">
        <Button variant={pathname === "/" ? "default" : "ghost"}>
          Dashboard
        </Button>
      </Link>
      <Link href="/teams">
        <Button variant={pathname === "/teams" ? "default" : "ghost"}>
          Teams
        </Button>
      </Link>
    </nav>
  );
}
