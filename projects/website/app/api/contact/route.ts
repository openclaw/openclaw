import { type NextRequest, NextResponse } from "next/server"
import { submitContactForm } from "@/lib/notion"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, email, subject, message, language, timestamp } = body

    // Validate required fields
    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        {
          success: false,
          message: "Missing required fields",
        },
        { status: 400 },
      )
    }

    const success = await submitContactForm({
      name,
      email,
      subject,
      message,
      language,
      timestamp: timestamp || new Date().toISOString(),
    })

    if (success) {
      return NextResponse.json(
        {
          success: true,
          message: "Contact form submitted successfully",
        },
        { status: 200 },
      )
    } else {
      throw new Error("Failed to submit to Notion")
    }
  } catch (error) {
    console.error("Error processing contact form:", error)
    return NextResponse.json(
      {
        success: false,
        message: "Failed to process contact form",
      },
      { status: 500 },
    )
  }
}
