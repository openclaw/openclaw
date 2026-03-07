import { Upload, Clock, Download } from "lucide-react";

interface ProgressStepsProps {
  currentStep: number;
}

export default function ProgressSteps({ currentStep }: ProgressStepsProps) {
  const steps = [
    { number: 1, title: "Upload Video", icon: Upload },
    { number: 2, title: "Add Timestamps", icon: Clock },
    { number: 3, title: "Process & Download", icon: Download },
  ];

  return (
    <div className="mb-8">
      <div className="flex items-center justify-center">
        <div className="flex items-center">
          {steps.map((step, index) => {
            const IconComponent = step.icon;
            return (
              <div key={step.number} className="flex items-center">
                <div className="flex items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      currentStep >= step.number
                        ? "bg-brand-green text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    <IconComponent size={16} />
                  </div>
                  <span
                    className={`ml-2 text-sm font-medium ${
                      currentStep >= step.number ? "text-gray-900" : "text-gray-500"
                    }`}
                  >
                    {step.title}
                  </span>
                </div>
                {index < steps.length - 1 && (
                  <div className="w-16 h-1 bg-gray-200 mx-4"></div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
