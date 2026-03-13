import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import Navbar from "@/components/Navbar";
import OnboardingClient from "./OnboardingClient";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/onboarding");

  const params = await searchParams;
  const upgraded = params.upgraded === "true";

  return (
    <>
      <Navbar />
      <main>
        <OnboardingClient upgraded={upgraded} userId={session.user.id} />
      </main>
    </>
  );
}
