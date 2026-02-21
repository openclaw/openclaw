import { Navbar } from "./components/navbar";
import { Hero } from "./components/hero";
import { Stats } from "./components/stats";
import { Problem } from "./components/problem";
import { Architecture } from "./components/architecture";
import { Security } from "./components/security";
import { Biology } from "./components/biology";
import { Roadmap } from "./components/roadmap";
import { CTA } from "./components/cta";
import { Footer } from "./components/footer";

export default function Home() {
  return (
    <main className="min-h-screen">
      <Navbar />
      <Hero />
      <Stats />
      <Problem />
      <Architecture />
      <Biology />
      <Security />
      <Roadmap />
      <CTA />
      <Footer />
    </main>
  );
}
