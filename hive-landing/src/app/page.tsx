import { Architecture } from "./components/architecture";
import { Biology } from "./components/biology";
import { CTA } from "./components/cta";
import { Footer } from "./components/footer";
import { Hero } from "./components/hero";
import { Navbar } from "./components/navbar";
import { Problem } from "./components/problem";
import { Roadmap } from "./components/roadmap";
import { Security } from "./components/security";
import { Stats } from "./components/stats";

export default function Home() {
  return (
    <main className="min-h-screen overflow-x-hidden">
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
