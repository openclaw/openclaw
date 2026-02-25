import { NextResponse } from "next/server";
import axios from "axios";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  try {
    const response = await axios.get(`https://${subdomain}.activi.io/api/health`);
    return NextResponse.json(response.data);
  } catch (error) {
    return NextResponse.json(
      { error: "Health check failed" },
      { status: 500 }
    );
  }
}
