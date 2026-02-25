import { NextResponse } from "next/server";
import axios from "axios";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  try {
    const response = await axios.get(`https://${subdomain}.activi.io/api/swarm/status`);
    return NextResponse.json(response.data);
  } catch (error) {
    return NextResponse.json(
      { error: "Swarm status check failed" },
      { status: 500 }
    );
  }
}
