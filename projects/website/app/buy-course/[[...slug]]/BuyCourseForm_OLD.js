'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { TriangleAlert, LoaderCircle } from 'lucide-react';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { createClient } from '@/utils/supabase/client.ts';
import { parseCourseName, parseCourseVariantName } from '@/utils/course.js';
import parsePriceString from '@/utils/parsePriceString.js';

export default function BuyCourseForm({ courses, defaultCourseId }) {
  const [state, setState] = useState('filling');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const router = useRouter();

  const formSchema = z.object({
    courseId: z.number({ message: '請選擇課程名稱' }).int().positive(),
    courseVariant: z.enum(['group', 'single'], { message: '請選擇上課方式' }),
  });
  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      courseId: defaultCourseId,
      courseVariant: null,
    },
  });
  const selectedCourseId = form.watch('courseId'); 
  const selectedCourseVariant = form.watch('courseVariant'); 
  const selectedCourse = courses.find(({ course_id }) => course_id === selectedCourseId);
  const total = selectedCourse ? {
    group: selectedCourse.group_price,
    single: selectedCourse.single_price,
  }[selectedCourseVariant] : 0;
  const totalEarly = selectedCourse ? {
    group: selectedCourse.group_price_early,
    single: selectedCourse.single_price_early,
  }[selectedCourseVariant] : 0;

  async function onSubmit(values) {
    if (state === 'filling') {
      setState('verifying');
      return;
    }

    setErrorMessage('');
    setLoading(true);

    const { courseId, courseVariant } = values;
    const supabase = createClient();
    const { data, error } = await supabase
      .from('orders')
      .insert({
        course_id: courseId,
        course_variant: courseVariant,
        total: totalEarly || total,
      })
      .select();

    if (error) {
      const { code, message } = error;
      setErrorMessage(`[${code}] ${message}`);
      setLoading(false);
      return;
    }

    router.replace(`/order/${data[0].order_id}`);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        className="max-w-3xl mx-auto space-y-5"
        onSubmit={form.handleSubmit(onSubmit)}
      >
        {state === 'filling' && (
        <FormCard title="步驟 1. 選擇欲報名課程">
          <div>
            <FormField
              control={form.control}
              name="courseId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    課程名稱
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <Select
                    value={String(field.value)}
                    onValueChange={value => {
                      field.onChange(Number(value));
                      form.setValue('courseVariant', null);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full min-w-0">
                        <SelectValue placeholder="請選擇" className="truncate" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {courses.map(course => (
                        <SelectItem key={course.course_id} value={String(course.course_id)}>
                          {parseCourseName(course)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <div>
            <FormField
              control={form.control}
              name="courseVariant"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    上課方式
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      className="grid grid-cols-2 gap-x-2 mt-2"
                    >
                      {!selectedCourse && (
                        <span>--</span>
                      )}
                      {selectedCourse && selectedCourse.group_price !== 0 && (
                      <FormItem className="flex items-start">
                        <FormControl>
                          <RadioGroupItem value="group" />
                        </FormControl>
                        <FormLabel className="flex-col items-start">
                          <span>小班制</span>
                          {selectedCourse && selectedCourse.group_price_early === 0 && (
                            <span className="font-bold text-orange-400">定價 <span className="font-mono">{parsePriceString(selectedCourse.group_price)}</span> 元</span>
                          )}
                          {selectedCourse && selectedCourse.group_price_early !== 0 && (
                            <>
                              <span className="line-through text-gray-500">原價 <span className="font-mono">{parsePriceString(selectedCourse.group_price)}</span> 元</span>
                              <span className="font-bold text-orange-400">早鳥價 <span className="font-mono">{parsePriceString(selectedCourse.group_price_early)}</span> 元</span>
                            </>
                          )}
                        </FormLabel>
                      </FormItem>
                      )}
                      {selectedCourse && selectedCourse.single_price !== 0 && (
                      <FormItem className="flex items-start">
                        <FormControl>
                          <RadioGroupItem value="single" />
                        </FormControl>
                        <FormLabel className="flex-col items-start">
                          <span>一對一</span>
                          {selectedCourse && selectedCourse.single_price_early === 0 && (
                            <span className="font-bold text-orange-400">定價 <span className="font-mono">{parsePriceString(selectedCourse.single_price)}</span> 元</span>
                          )}
                          {selectedCourse && selectedCourse.single_price_early !== 0 && (
                            <>
                              <span className="line-through text-gray-500">原價 <span className="font-mono">{parsePriceString(selectedCourse.single_price)}</span> 元</span>
                              <span className="font-bold text-orange-400">早鳥價 <span className="font-mono">{parsePriceString(selectedCourse.single_price_early)}</span> 元</span>
                            </>
                          )}
                        </FormLabel>
                      </FormItem>
                      )}
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormCard>
        )}
        {state === 'verifying' && (
          <FormCard singleColumn title="步驟 2. 確認報名資訊">
            <p>
              課程名稱：{parseCourseName(selectedCourse)}<br />
              上課方式：{parseCourseVariantName(selectedCourseVariant)}<br />
              課程費用：新台幣 <span className="font-mono">{parsePriceString(totalEarly || total)}</span> 元<br />
            </p>
          </FormCard>
        )}
        {errorMessage && (
          <FormCard error singleColumn>
            <p className="flex items-center gap-2">
              <TriangleAlert size={18} />
              {errorMessage}
            </p>
          </FormCard>
        )}
        <FormFooter>
          {state === 'filling' && (
            <>
              <FormButton primary type="submit">
                繼續
              </FormButton>
              <FormButton type="button" onClick={() => router.back()}>
                返回
              </FormButton>
            </>
          )}
          {state === 'verifying' && (
            <>
              <FormButton
                primary
                type="submit"
                disabled={loading}
              >
                {loading && <LoaderCircle size={20} className="mr-1 animate-spin" />}
                確認無誤，前往繳費
              </FormButton>
              <FormButton
                type="button"
                onClick={() => setState('filling')}
                disabled={loading}
              >
                我選錯了，返回修改
              </FormButton>
            </>
          )}
        </FormFooter>
      </form>
    </Form>
  );
}
